import type { DB } from './db/connection.js';
import { vectorSupportError } from './db/connection.js';

export interface RankedCandidate {
  id: number;
  /** 0..1, higher is more similar. */
  score: number;
}

export interface SimilarResult {
  /** Null when the mod is not in the database. */
  target: { id: number; name: string; title: string } | null;
  candidates: RankedCandidate[];
  /** Which signals were available for this mod. */
  signals: { theme: boolean; tags: boolean; dependencies: boolean };
}

// How much each signal contributes to the final score. Theme similarity is the strongest
// signal; tags and shared dependencies refine it (and stand in when there is no index).
const WEIGHTS = { theme: 0.6, tags: 0.25, dependencies: 0.15 };
const THEME_NEIGHBOURS = 300;
const MAX_CANDIDATES = 400;

/**
 * Finds mods similar to `name` by combining three signals:
 * - theme: cosine similarity of title + summary embeddings (if the index exists),
 * - tags: Jaccard similarity of tag sets,
 * - dependencies: shared required dependencies, weighted by rarity (sharing a niche
 *   library says much more than sharing a ubiquitous one).
 * The mod itself and the mods it directly requires (its libraries) are excluded.
 */
export function findSimilar(db: DB, name: string): SimilarResult {
  const target = db.prepare('SELECT id, name, title FROM mods WHERE name = ?').get(name) as
    { id: number; name: string; title: string } | undefined;
  const signals = { theme: false, tags: false, dependencies: false };
  if (!target) return { target: null, candidates: [], signals };

  const scores = new Map<number, { theme: number; tags: number; dependencies: number }>();
  const entry = (id: number) => {
    let s = scores.get(id);
    if (!s) scores.set(id, (s = { theme: 0, tags: 0, dependencies: 0 }));
    return s;
  };

  // Theme: nearest neighbours of the mod's own stored vector.
  const hasIndex =
    !vectorSupportError(db) &&
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_mods'").get();
  if (hasIndex) {
    const row = db
      .prepare('SELECT embedding FROM vec_mods WHERE rowid = ?')
      .get(BigInt(target.id)) as { embedding: Buffer } | undefined;
    if (row) {
      signals.theme = true;
      const neighbours = db
        .prepare('SELECT rowid AS id, distance FROM vec_mods WHERE embedding MATCH ? AND k = ?')
        .all(row.embedding, THEME_NEIGHBOURS + 1) as { id: number; distance: number }[];
      // Cosine distance 0..2 -> similarity 1..-1; clamp at 0.
      for (const n of neighbours) entry(Number(n.id)).theme = Math.max(0, 1 - n.distance);
    }
  }

  // Tags: Jaccard similarity with every mod sharing at least one tag.
  const tagRows = db
    .prepare(
      `WITH mine AS (SELECT tag FROM mod_tags WHERE mod_name = @name),
            sizes AS (SELECT mod_name, COUNT(*) AS n FROM mod_tags GROUP BY mod_name)
       SELECT m.id, COUNT(*) AS shared, s.n AS size, (SELECT COUNT(*) FROM mine) AS mine
       FROM mod_tags t JOIN mine USING (tag)
       JOIN mods m ON m.name = t.mod_name JOIN sizes s ON s.mod_name = t.mod_name
       WHERE t.mod_name <> @name GROUP BY t.mod_name`,
    )
    .all({ name }) as { id: number; shared: number; size: number; mine: number }[];
  if (tagRows.length) signals.tags = true;
  for (const r of tagRows) entry(r.id).tags = r.shared / (r.mine + r.size - r.shared);

  // Dependencies: shared required dependencies weighted by inverse popularity.
  const depRows = db
    .prepare(
      `WITH mine AS (
         SELECT dep_name FROM dependencies
         WHERE mod_name = @name AND kind = 'required' AND dep_name NOT IN ('base', 'space-age', 'quality', 'elevated-rails')
       ),
       weight AS (
         SELECT d.dep_name, 1.0 / ln(2 + COUNT(*)) AS w FROM dependencies d JOIN mine USING (dep_name)
         WHERE d.kind = 'required' GROUP BY d.dep_name
       )
       SELECT m.id, SUM(weight.w) AS raw, (SELECT SUM(w) FROM weight) AS total
       FROM dependencies d JOIN weight USING (dep_name) JOIN mods m ON m.name = d.mod_name
       WHERE d.kind = 'required' AND d.mod_name <> @name GROUP BY d.mod_name`,
    )
    .all({ name }) as { id: number; raw: number; total: number }[];
  if (depRows.length) signals.dependencies = true;
  for (const r of depRows) entry(r.id).dependencies = r.total ? r.raw / r.total : 0;

  // Libraries the mod requires are dependencies, not alternatives.
  const excluded = new Set<number>([
    target.id,
    ...(
      db
        .prepare(
          `SELECT m.id FROM dependencies d JOIN mods m ON m.name = d.dep_name
           WHERE d.mod_name = ? AND d.kind = 'required'`,
        )
        .all(name) as { id: number }[]
    ).map((r) => r.id),
  ]);

  // Re-normalise the weights over the signals this mod actually has.
  const active = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).filter((k) => signals[k]);
  const totalWeight = active.reduce((sum, k) => sum + WEIGHTS[k], 0) || 1;

  const candidates = [...scores.entries()]
    .filter(([id]) => !excluded.has(id))
    .map(([id, s]) => ({
      id,
      score: active.reduce((sum, k) => sum + WEIGHTS[k] * s[k], 0) / totalWeight,
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  return { target, candidates, signals };
}
