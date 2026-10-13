import type { ModFilter } from '../shared/filters.js';

export interface BuiltQuery {
  /** Selects one page of results. */
  sql: string;
  /** Counts all matching rows (same WHERE clause, no paging). */
  countSql: string;
  params: unknown[];
  countParams: unknown[];
}

/**
 * Converts free text into a safe FTS5 query: every word becomes a quoted prefix
 * term, and all terms must match. Returns null if there is nothing to search for.
 * Example: `space "rail" mk2` -> `"space"* "rail"* "mk2"*`
 */
export function toFtsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words?.length) return null;
  return words
    .slice(0, 16)
    .map((w) => `"${w}"*`)
    .join(' ');
}

const SELECT_COLUMNS = `
  m.name, m.title, m.owner, m.summary, m.category, m.downloads_count, m.score,
  m.latest_version, m.latest_release_at, m.factorio_version, m.created_at,
  m.requires_space_age, m.incompatible_space_age, m.deprecated, m.thumbnail,
  m.full_synced_at IS NOT NULL AS has_details, m.removed_at,
  (SELECT group_concat(t.tag, ',') FROM mod_tags t WHERE t.mod_name = m.name) AS tags`;

/** A precomputed ranking (e.g. "Find similar"): only these mods, ordered by score. */
export interface RankedInput {
  candidates: { id: number; score: number }[];
}

export interface SemanticInput {
  /** Query embedding as a float32 blob (see embeddings/index.ts vectorBlob). */
  vector: Buffer;
  /** Nearest neighbours to consider before filters are applied. */
  k: number;
}

// bm25 column weights: name, title, summary, description.
const RANK = 'bm25(mods_fts, 10.0, 8.0, 3.0, 1.0)';
const POPULARITY_WEIGHT = 1.0;
// Theme search: cosine distance (0..2) nudged slightly by popularity.
const SEMANTIC_POPULARITY_WEIGHT = 0.025;
// "Find similar": score (0..1) nudged slightly by popularity.
const RANKED_POPULARITY_WEIGHT = 0.02;

/**
 * Builds a parameterized SQL query from a validated filter. No values are interpolated.
 * Theme search (`f.semantic`) only applies when the caller passes the query embedding:
 * the k nearest mods are taken from sqlite-vec, then the other filters narrow them down.
 */
export function buildModQuery(
  f: ModFilter,
  semantic?: SemanticInput,
  ranked?: RankedInput,
): BuiltQuery {
  const where: string[] = [];
  const params: unknown[] = [];

  const fts = f.q ? toFtsQuery(f.q) : null;
  const sem = f.semantic && semantic ? semantic : null;
  let from = 'mods m';
  const fromParams: unknown[] = [];
  if (fts) {
    from += ` JOIN (SELECT rowid, ${RANK} AS rank FROM mods_fts WHERE mods_fts MATCH ?) fts ON fts.rowid = m.id`;
    fromParams.push(fts);
  }
  if (sem) {
    from +=
      ' JOIN (SELECT rowid, distance FROM vec_mods WHERE embedding MATCH ? AND k = ?) sem ON sem.rowid = m.id';
    fromParams.push(sem.vector, sem.k);
  }
  const rk = f.similarTo && ranked ? ranked : null;
  if (rk) {
    // Passed as one JSON parameter: [[id, score], …].
    from +=
      " JOIN (SELECT value ->> '$[0]' AS id, value ->> '$[1]' AS score FROM json_each(?)) rk ON rk.id = m.id";
    fromParams.push(JSON.stringify(rk.candidates.map((c) => [c.id, c.score])));
  }

  if (!f.includeRemoved) where.push('m.removed_at IS NULL');
  if (f.hideDeprecated) where.push('m.deprecated = 0');

  if (f.categories?.length) {
    where.push(`m.category IN (${f.categories.map(() => '?').join(', ')})`);
    params.push(...f.categories);
  }

  if (f.tags?.length) {
    if (f.tagMode === 'any') {
      where.push(
        `EXISTS (SELECT 1 FROM mod_tags t WHERE t.mod_name = m.name AND t.tag IN (${f.tags.map(() => '?').join(', ')}))`,
      );
      params.push(...f.tags);
    } else {
      for (const tag of f.tags) {
        where.push('EXISTS (SELECT 1 FROM mod_tags t WHERE t.mod_name = m.name AND t.tag = ?)');
        params.push(tag);
      }
    }
  }

  if (f.owner) {
    where.push('m.owner = ? COLLATE NOCASE');
    params.push(f.owner);
  }

  if (f.factorioVersion) {
    if (f.versionMatch === 'latest') {
      where.push('m.factorio_version = ?');
      params.push(f.factorioVersion);
    } else {
      // Release history is only known for detailed mods; fall back to the latest release.
      where.push(
        '(m.factorio_version = ? OR EXISTS (SELECT 1 FROM mod_releases r WHERE r.mod_name = m.name AND r.factorio_version = ?))',
      );
      params.push(f.factorioVersion, f.factorioVersion);
    }
  }

  if (f.spaceAge === 'required') where.push('m.requires_space_age = 1');
  else if (f.spaceAge === 'excluded') where.push('m.requires_space_age = 0');
  else if (f.spaceAge === 'incompatible') where.push('m.incompatible_space_age = 1');

  if (f.minDownloads !== undefined && f.minDownloads > 0) {
    where.push('m.downloads_count >= ?');
    params.push(f.minDownloads);
  }

  if (f.updatedSince) {
    where.push('m.latest_release_at >= ?');
    params.push(f.updatedSince);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const desc = (f.order ?? (f.sort === 'title' ? 'asc' : 'desc')) === 'desc';
  const dir = desc ? 'DESC' : 'ASC';
  const orderParams: unknown[] = [];
  let orderBy: string;
  switch (f.sort) {
    case 'relevance':
      if (rk) {
        orderBy = `rk.score + ${RANKED_POPULARITY_WEIGHT} * log10(m.downloads_count + 1) ${dir}`;
      } else if (sem) {
        orderBy = `sem.distance - ${SEMANTIC_POPULARITY_WEIGHT} * log10(m.downloads_count + 1) ${dir === 'DESC' ? 'ASC' : 'DESC'}`;
      } else if (fts) {
        // Exact name/title matches first, then bm25 (lower is better) nudged by popularity,
        // so a well-known mod beats an obscure one with a slightly better text match.
        orderBy = `(m.name = ? COLLATE NOCASE OR m.title = ? COLLATE NOCASE) DESC, fts.rank - ${POPULARITY_WEIGHT} * log10(m.downloads_count + 1) ${desc ? 'ASC' : 'DESC'}`;
        orderParams.push(f.q, f.q);
      } else {
        orderBy = `m.downloads_count ${dir}`;
      }
      break;
    case 'downloads':
      orderBy = `m.downloads_count ${dir}`;
      break;
    case 'score':
      orderBy = `m.score ${dir}, m.downloads_count DESC`;
      break;
    case 'updated':
      orderBy = `m.latest_release_at IS NULL, m.latest_release_at ${dir}`;
      break;
    case 'created':
      orderBy = `m.created_at IS NULL, m.created_at ${dir}`;
      break;
    case 'title':
      orderBy = `m.title COLLATE NOCASE ${dir}`;
      break;
  }

  const offset = (f.page - 1) * f.pageSize;
  return {
    sql: `SELECT ${SELECT_COLUMNS}, ${rk ? 'rk.score' : sem ? '1 - sem.distance' : 'NULL'} AS similarity FROM ${from} ${whereSql} ORDER BY ${orderBy}, m.name ASC LIMIT ? OFFSET ?`,
    countSql: `SELECT COUNT(*) AS total FROM ${from} ${whereSql}`,
    params: [...fromParams, ...params, ...orderParams, f.pageSize, offset],
    countParams: [...fromParams, ...params],
  };
}
