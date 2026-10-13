import type { DB } from '../db/connection.js';
import { normalizeFactorioVersion, parseDependencies } from '../deps.js';
import type { PortalFullMod, PortalListEntry, PortalRelease } from '../portal/types.js';

export interface ListApplyResult {
  listed: number;
  added: string[];
  changed: string[];
  removed: string[];
  restored: string[];
}

/**
 * Upserts the summary fields from /api/mods and detects which mods are new or
 * have a new latest release since the previous sync.
 */
export function applyModList(db: DB, entries: PortalListEntry[], now: string): ListApplyResult {
  const known = new Map(
    (
      db.prepare('SELECT name, latest_version, latest_sha1, removed_at FROM mods').all() as {
        name: string;
        latest_version: string | null;
        latest_sha1: string | null;
        removed_at: string | null;
      }[]
    ).map((r) => [r.name, r]),
  );

  const upsert = db.prepare(`
    INSERT INTO mods (name, title, owner, summary, category, downloads_count, score,
      requires_space_age, last_highlighted_at, latest_version, latest_release_at, latest_sha1,
      factorio_version, list_synced_at, removed_at)
    VALUES (@name, @title, @owner, @summary, @category, @downloads_count, @score,
      @requires_space_age, @last_highlighted_at, @latest_version, @latest_release_at, @latest_sha1,
      @factorio_version, @now, NULL)
    ON CONFLICT(name) DO UPDATE SET
      title = excluded.title, owner = excluded.owner, summary = excluded.summary,
      category = excluded.category, downloads_count = excluded.downloads_count,
      score = excluded.score, requires_space_age = excluded.requires_space_age,
      last_highlighted_at = excluded.last_highlighted_at,
      latest_version = excluded.latest_version, latest_release_at = excluded.latest_release_at,
      latest_sha1 = excluded.latest_sha1, factorio_version = excluded.factorio_version,
      list_synced_at = excluded.list_synced_at, removed_at = NULL
  `);

  const result: ListApplyResult = {
    listed: entries.length,
    added: [],
    changed: [],
    removed: [],
    restored: [],
  };
  const seen = new Set<string>();

  db.transaction(() => {
    for (const entry of entries) {
      if (!entry?.name || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const release = entry.latest_release;
      const prev = known.get(entry.name);
      if (!prev) result.added.push(entry.name);
      else {
        if (prev.removed_at) result.restored.push(entry.name);
        if (
          prev.latest_version !== (release?.version ?? null) ||
          prev.latest_sha1 !== (release?.sha1 ?? null)
        ) {
          result.changed.push(entry.name);
        }
      }
      upsert.run({
        name: entry.name,
        title: entry.title ?? entry.name,
        owner: entry.owner ?? '',
        summary: entry.summary ?? '',
        category: entry.category || 'no-category',
        downloads_count: entry.downloads_count ?? 0,
        score: entry.score ?? 0,
        requires_space_age: entry.requires_space_age ? 1 : 0,
        last_highlighted_at: entry.last_highlighted_at ?? null,
        latest_version: release?.version ?? null,
        latest_release_at: release?.released_at ?? null,
        latest_sha1: release?.sha1 ?? null,
        factorio_version: normalizeFactorioVersion(release?.info_json?.factorio_version),
        now,
      });
    }

    // Guard against wiping the catalogue on an empty or truncated response.
    const active = [...known.values()].filter((r) => !r.removed_at).length;
    if (seen.size > 0 && seen.size >= active * 0.5) {
      const markRemoved = db.prepare('UPDATE mods SET removed_at = ? WHERE name = ?');
      const unqueue = db.prepare('DELETE FROM sync_queue WHERE mod_name = ?');
      for (const [name, row] of known) {
        if (!seen.has(name) && !row.removed_at) {
          markRemoved.run(now, name);
          unqueue.run(name);
          result.removed.push(name);
        }
      }
    }
  })();

  return result;
}

function latestRelease(releases: PortalRelease[] | undefined): PortalRelease | undefined {
  if (!releases?.length) return undefined;
  return releases.reduce((a, b) => ((b.released_at ?? '') > (a.released_at ?? '') ? b : a));
}

/** Stores the details from /api/mods/{name}/full: description, tags, releases, dependencies. */
export function applyFullMod(db: DB, mod: PortalFullMod, now: string): void {
  const latest = latestRelease(mod.releases);
  const deps = parseDependencies(latest?.info_json?.dependencies);
  const requiresSpaceAge =
    mod.requires_space_age === true ||
    deps.some((d) => d.name === 'space-age' && d.kind === 'required');
  const incompatibleSpaceAge = deps.some(
    (d) => d.name === 'space-age' && d.kind === 'incompatible',
  );

  db.transaction(() => {
    db.prepare(
      `
      UPDATE mods SET
        title = @title, owner = @owner, summary = @summary, description = @description,
        category = @category, downloads_count = @downloads_count, score = @score,
        created_at = @created_at, updated_at = @updated_at,
        -- latest_* come from the mod list; remember which release these details describe.
        latest_version = COALESCE(latest_version, @latest_version),
        latest_release_at = COALESCE(latest_release_at, @latest_release_at),
        latest_sha1 = COALESCE(latest_sha1, @latest_sha1),
        factorio_version = COALESCE(factorio_version, @factorio_version),
        details_sha1 = COALESCE(latest_sha1, @latest_sha1),
        requires_space_age = @requires_space_age,
        incompatible_space_age = @incompatible_space_age,
        deprecated = @deprecated, feature_flags = @feature_flags, thumbnail = @thumbnail,
        source_url = @source_url, homepage = @homepage,
        license_id = @license_id, license_title = @license_title, license_url = @license_url,
        changelog = @changelog, faq = @faq, last_highlighted_at = @last_highlighted_at,
        full_synced_at = @now
      WHERE name = @name
    `,
    ).run({
      name: mod.name,
      title: mod.title ?? mod.name,
      owner: mod.owner ?? '',
      summary: mod.summary ?? '',
      description: mod.description ?? '',
      category: mod.category || 'no-category',
      downloads_count: mod.downloads_count ?? 0,
      score: mod.score ?? 0,
      created_at: mod.created_at ?? null,
      updated_at: mod.updated_at ?? null,
      latest_version: latest?.version ?? null,
      latest_release_at: latest?.released_at ?? null,
      latest_sha1: latest?.sha1 ?? null,
      factorio_version: normalizeFactorioVersion(latest?.info_json?.factorio_version),
      requires_space_age: requiresSpaceAge ? 1 : 0,
      incompatible_space_age: incompatibleSpaceAge ? 1 : 0,
      deprecated: mod.deprecated ? 1 : 0,
      feature_flags: latest?.feature_flags?.length ? JSON.stringify(latest.feature_flags) : null,
      thumbnail: mod.thumbnail && mod.thumbnail !== '/assets/.thumb.png' ? mod.thumbnail : null,
      source_url:
        mod.source_url || (mod.github_path ? `https://github.com/${mod.github_path}` : null),
      homepage: mod.homepage || null,
      license_id: mod.license?.id ?? null,
      license_title: mod.license?.title ?? null,
      license_url: mod.license?.url ?? null,
      changelog: mod.changelog ?? null,
      faq: mod.faq ?? null,
      last_highlighted_at: mod.last_highlighted_at ?? null,
      now,
    });

    db.prepare('DELETE FROM mod_tags WHERE mod_name = ?').run(mod.name);
    const insertTag = db.prepare('INSERT OR IGNORE INTO mod_tags (mod_name, tag) VALUES (?, ?)');
    for (const tag of mod.tags ?? []) if (typeof tag === 'string') insertTag.run(mod.name, tag);

    db.prepare('DELETE FROM mod_releases WHERE mod_name = ?').run(mod.name);
    const insertRelease = db.prepare(
      'INSERT OR IGNORE INTO mod_releases (mod_name, version, factorio_version, released_at, sha1) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of mod.releases ?? []) {
      if (!r?.version) continue;
      insertRelease.run(
        mod.name,
        r.version,
        normalizeFactorioVersion(r.info_json?.factorio_version),
        r.released_at ?? null,
        r.sha1 ?? null,
      );
    }

    db.prepare('DELETE FROM dependencies WHERE mod_name = ?').run(mod.name);
    const insertDep = db.prepare(
      'INSERT INTO dependencies (mod_name, dep_name, kind, operator, version, raw) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const d of deps) {
      if (d.name === mod.name) continue;
      insertDep.run(mod.name, d.name, d.kind, d.operator, d.version, d.raw);
    }
  })();
}
