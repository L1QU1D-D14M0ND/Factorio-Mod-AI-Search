import { isOfficialMod, OFFICIAL_DLC, BASE_MOD } from '../shared/constants.js';
import type { DependencyKind } from '../shared/constants.js';
import type { ModFilter } from '../shared/filters.js';
import type { FacetsResponse, ModDetail, ModSummary, SearchResponse } from '../shared/types.js';
import type { DB } from './db/connection.js';
import { compareVersions } from './deps.js';
import { buildModQuery } from './query.js';

export interface RepoOptions {
  assetsUrl: string;
  portalUrl: string;
}

interface ModRow {
  name: string;
  title: string;
  owner: string;
  summary: string;
  category: string;
  downloads_count: number;
  score: number;
  latest_version: string | null;
  latest_release_at: string | null;
  factorio_version: string | null;
  created_at: string | null;
  requires_space_age: number;
  incompatible_space_age: number;
  deprecated: number;
  thumbnail: string | null;
  has_details: number;
  removed_at: string | null;
  tags: string | null;
}

export class ModRepository {
  constructor(
    private readonly db: DB,
    private readonly opts: RepoOptions,
  ) {}

  thumbnailUrl(path: string | null): string | null {
    return path ? this.opts.assetsUrl + path : null;
  }

  private toSummary(row: ModRow): ModSummary {
    return {
      name: row.name,
      title: row.title,
      owner: row.owner,
      summary: row.summary,
      category: row.category,
      downloadsCount: row.downloads_count,
      score: row.score,
      latestVersion: row.latest_version,
      latestReleaseAt: row.latest_release_at,
      factorioVersion: row.factorio_version,
      createdAt: row.created_at,
      requiresSpaceAge: !!row.requires_space_age,
      incompatibleSpaceAge: !!row.incompatible_space_age,
      deprecated: !!row.deprecated,
      thumbnailUrl: this.thumbnailUrl(row.thumbnail),
      tags: row.tags ? row.tags.split(',') : [],
      hasDetails: !!row.has_details,
      removed: !!row.removed_at,
    };
  }

  search(filter: ModFilter): SearchResponse {
    const q = buildModQuery(filter);
    const rows = this.db.prepare(q.sql).all(...q.params) as ModRow[];
    const { total } = this.db.prepare(q.countSql).get(...q.countParams) as { total: number };
    return {
      total,
      page: filter.page,
      pageSize: filter.pageSize,
      items: rows.map((r) => this.toSummary(r)),
    };
  }

  getMod(name: string): ModDetail | null {
    const row = this.db
      .prepare(
        `SELECT m.*, m.full_synced_at IS NOT NULL AS has_details,
           (SELECT group_concat(t.tag, ',') FROM mod_tags t WHERE t.mod_name = m.name) AS tags
         FROM mods m WHERE m.name = ?`,
      )
      .get(name) as
      | (ModRow & {
          description: string;
          updated_at: string | null;
          source_url: string | null;
          homepage: string | null;
          license_id: string | null;
          license_title: string | null;
          license_url: string | null;
          feature_flags: string | null;
        })
      | undefined;
    if (!row) return null;

    const releases = (
      this.db
        .prepare(
          `SELECT version, factorio_version, released_at FROM mod_releases
           WHERE mod_name = ? ORDER BY released_at DESC`,
        )
        .all(name) as {
        version: string;
        factorio_version: string | null;
        released_at: string | null;
      }[]
    ).map((r) => ({
      version: r.version,
      factorioVersion: r.factorio_version,
      releasedAt: r.released_at,
    }));

    const deps = this.db
      .prepare(
        `SELECT d.dep_name, d.kind, d.operator, d.version, m.title
         FROM dependencies d LEFT JOIN mods m ON m.name = d.dep_name
         WHERE d.mod_name = ? ORDER BY d.dep_name COLLATE NOCASE`,
      )
      .all(name) as {
      dep_name: string;
      kind: DependencyKind;
      operator: string | null;
      version: string | null;
      title: string | null;
    }[];

    const requiredBy = this.db
      .prepare(
        `SELECT m.name, m.title, m.downloads_count FROM dependencies d
         JOIN mods m ON m.name = d.mod_name
         WHERE d.dep_name = ? AND d.kind = 'required' AND m.removed_at IS NULL
         ORDER BY m.downloads_count DESC LIMIT 20`,
      )
      .all(name) as { name: string; title: string; downloads_count: number }[];
    const { n: requiredByCount } = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM dependencies d JOIN mods m ON m.name = d.mod_name
         WHERE d.dep_name = ? AND d.kind = 'required' AND m.removed_at IS NULL`,
      )
      .get(name) as { n: number };

    return {
      ...this.toSummary(row),
      description: row.description,
      updatedAt: row.updated_at,
      sourceUrl: row.source_url,
      homepage: row.homepage,
      license: { id: row.license_id, title: row.license_title, url: row.license_url },
      featureFlags: row.feature_flags ? (JSON.parse(row.feature_flags) as string[]) : [],
      portalUrl: `${this.opts.portalUrl}/mod/${encodeURIComponent(name)}`,
      releases,
      dependencies: deps.map((d) => {
        const official = isOfficialMod(d.dep_name);
        return {
          name: d.dep_name,
          kind: d.kind,
          operator: d.operator,
          version: d.version,
          title: official ? officialTitle(d.dep_name) : d.title,
          official,
          known: official || d.title !== null,
        };
      }),
      requiredBy: requiredBy.map((r) => ({
        name: r.name,
        title: r.title,
        downloadsCount: r.downloads_count,
      })),
      requiredByCount,
    };
  }

  facets(): FacetsResponse {
    const categories = this.db
      .prepare(
        `SELECT category AS value, COUNT(*) AS count FROM mods
         WHERE removed_at IS NULL GROUP BY category ORDER BY count DESC`,
      )
      .all() as FacetsResponse['categories'];
    const tags = this.db
      .prepare(
        `SELECT t.tag AS value, COUNT(*) AS count FROM mod_tags t
         JOIN mods m ON m.name = t.mod_name WHERE m.removed_at IS NULL
         GROUP BY t.tag ORDER BY t.tag`,
      )
      .all() as FacetsResponse['tags'];
    // Only versions declared by a meaningful number of mods (skips typos like "6.9").
    const factorioVersions = (
      this.db
        .prepare(
          `SELECT factorio_version AS value, COUNT(*) AS count FROM mods
           WHERE removed_at IS NULL AND factorio_version IS NOT NULL
           GROUP BY factorio_version HAVING COUNT(*) >= 10`,
        )
        .all() as FacetsResponse['factorioVersions']
    ).sort((a, b) => compareVersions(b.value, a.value));
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS mods, COUNT(full_synced_at) AS detailed FROM mods WHERE removed_at IS NULL`,
      )
      .get() as FacetsResponse['totals'];
    return { categories, tags, factorioVersions, totals };
  }
}

export function officialTitle(name: string): string {
  return name === BASE_MOD ? 'Base game' : (OFFICIAL_DLC[name]?.title ?? name);
}
