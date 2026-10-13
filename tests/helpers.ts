import { openDatabase, type DB } from '../src/core/db/connection.js';
import { applyFullMod, applyModList } from '../src/core/sync/apply.js';
import type { PortalFullMod, PortalListEntry } from '../src/core/portal/types.js';

export const NOW = '2026-10-01T00:00:00.000Z';

export function listEntry(
  name: string,
  overrides: Partial<PortalListEntry> & {
    version?: string;
    factorio?: string;
    releasedAt?: string;
  } = {},
): PortalListEntry {
  const {
    version = '1.0.0',
    factorio = '2.0',
    releasedAt = '2026-01-01T00:00:00Z',
    ...rest
  } = overrides;
  return {
    name,
    title: name,
    owner: 'someone',
    summary: '',
    category: 'content',
    downloads_count: 100,
    score: 0,
    latest_release: {
      version,
      released_at: releasedAt,
      sha1: `${name}-${version}`,
      info_json: { factorio_version: factorio },
    },
    ...rest,
  };
}

export function fullMod(
  entry: PortalListEntry,
  extra: Partial<PortalFullMod> & { dependencies?: string[]; olderFactorio?: string[] } = {},
): PortalFullMod {
  const { dependencies = ['base'], olderFactorio = [], ...rest } = extra;
  const latest = entry.latest_release!;
  return {
    ...entry,
    description: '',
    tags: [],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: latest.released_at,
    releases: [
      ...olderFactorio.map((fv, i) => ({
        version: `0.${i}.0`,
        released_at: `2024-0${i + 1}-01T00:00:00Z`,
        info_json: { factorio_version: fv, dependencies: [] },
      })),
      { ...latest, info_json: { ...latest.info_json, dependencies } },
    ],
    ...rest,
  };
}

/** In-memory DB seeded with list entries and (optionally) their /full details. */
export function seedDb(mods: { entry: PortalListEntry; full?: PortalFullMod }[]): DB {
  const db = openDatabase(':memory:');
  applyModList(
    db,
    mods.map((m) => m.entry),
    NOW,
  );
  for (const m of mods) if (m.full) applyFullMod(db, m.full, NOW);
  return db;
}
