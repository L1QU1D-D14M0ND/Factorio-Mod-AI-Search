import { BASE_MOD, isOfficialMod, OFFICIAL_DLC } from '../../shared/constants.js';
import type { DB } from '../db/connection.js';
import { officialTitle } from '../repo.js';

export interface ExportMod {
  name: string;
  title: string;
  owner: string | null;
  version: string | null;
  factorioVersion: string | null;
  summary: string;
  /** Relative thumbnail path on the portal's asset server, if any. */
  thumbnail: string | null;
  official: boolean;
  /** Present in the local DB (or an official DLC). */
  known: boolean;
  /** Added automatically because a selected mod requires it. */
  addedAsDependency: boolean;
  /** Names of mods in the export that require this one. */
  requiredBy: string[];
}

export interface ResolvedList {
  mods: ExportMod[];
  warnings: string[];
}

interface Row {
  name: string;
  title: string;
  owner: string;
  latest_version: string | null;
  factorio_version: string | null;
  summary: string;
  full_synced_at: string | null;
  thumbnail: string | null;
}

/**
 * Expands a list of mod names into export entries. With `includeDependencies`, required
 * dependencies are followed recursively (DLC included). `base` is never listed here:
 * it is the base game and always enabled.
 */
export function resolveList(db: DB, names: string[], includeDependencies: boolean): ResolvedList {
  const getMod = db.prepare(
    'SELECT name, title, owner, latest_version, factorio_version, summary, full_synced_at, thumbnail FROM mods WHERE name = ?',
  );
  const getRequired = db.prepare(
    "SELECT dep_name FROM dependencies WHERE mod_name = ? AND kind = 'required' ORDER BY dep_name",
  );

  const result = new Map<string, ExportMod>();
  const warnings: string[] = [];
  const queue: { name: string; parent: string | null }[] = names.map((name) => ({
    name,
    parent: null,
  }));

  while (queue.length) {
    const { name, parent } = queue.shift()!;
    if (name === BASE_MOD) continue;
    const existing = result.get(name);
    if (existing) {
      if (parent && !existing.requiredBy.includes(parent)) existing.requiredBy.push(parent);
      continue;
    }

    let entry: ExportMod;
    let children: string[] = [];
    if (isOfficialMod(name)) {
      entry = {
        name,
        title: officialTitle(name),
        owner: 'Wube Software',
        thumbnail: null,
        version: null,
        factorioVersion: null,
        summary: 'Official expansion content',
        official: true,
        known: true,
        addedAsDependency: parent !== null,
        requiredBy: parent ? [parent] : [],
      };
      children = OFFICIAL_DLC[name]?.requires ?? [];
    } else {
      const row = getMod.get(name) as Row | undefined;
      entry = {
        name,
        title: row?.title ?? name,
        owner: row?.owner ?? null,
        thumbnail: row?.thumbnail ?? null,
        version: row?.latest_version ?? null,
        factorioVersion: row?.factorio_version ?? null,
        summary: row?.summary ?? '',
        official: false,
        known: !!row,
        addedAsDependency: parent !== null,
        requiredBy: parent ? [parent] : [],
      };
      if (!row) warnings.push(`"${name}" is not in the local database.`);
      else if (includeDependencies && !row.full_synced_at) {
        warnings.push(`Dependencies of "${name}" are unknown (details not synced yet).`);
      }
      if (row) children = (getRequired.all(name) as { dep_name: string }[]).map((r) => r.dep_name);
    }

    result.set(name, entry);
    if (includeDependencies)
      for (const child of children) queue.push({ name: child, parent: name });
  }

  return { mods: [...result.values()], warnings };
}
