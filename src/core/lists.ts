import { isOfficialMod } from '../shared/constants.js';
import type { ListDetail, ListItem, ModList } from '../shared/types.js';
import type { DB } from './db/connection.js';
import { officialTitle } from './repo.js';

export class ListNotFoundError extends Error {}

interface ListRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  item_count: number;
}

const toList = (r: ListRow): ModList => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  itemCount: r.item_count,
});

const LIST_SELECT = `SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count FROM lists l`;

/** Saved mod lists ("baskets") stored in the database. */
export class ListRepository {
  constructor(
    private readonly db: DB,
    private readonly thumbnailUrl: (path: string | null) => string | null,
  ) {}

  all(): ModList[] {
    return (this.db.prepare(`${LIST_SELECT} ORDER BY l.updated_at DESC`).all() as ListRow[]).map(
      toList,
    );
  }

  create(name: string): ModList {
    const now = new Date().toISOString();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO lists (name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(name, now, now);
    return this.summary(Number(lastInsertRowid));
  }

  rename(id: number, name: string): ModList {
    const res = this.db
      .prepare('UPDATE lists SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, new Date().toISOString(), id);
    if (!res.changes) throw new ListNotFoundError(`List ${id} not found`);
    return this.summary(id);
  }

  remove(id: number): void {
    const res = this.db.prepare('DELETE FROM lists WHERE id = ?').run(id);
    if (!res.changes) throw new ListNotFoundError(`List ${id} not found`);
  }

  addItems(id: number, names: string[]): ListDetail {
    this.summary(id);
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO list_items (list_id, mod_name, added_at) VALUES (?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const name of names) insert.run(id, name, now);
      this.touch(id);
    })();
    return this.get(id);
  }

  removeItem(id: number, name: string): ListDetail {
    this.summary(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM list_items WHERE list_id = ? AND mod_name = ?').run(id, name);
      this.touch(id);
    })();
    return this.get(id);
  }

  clear(id: number): ListDetail {
    this.summary(id);
    this.db.prepare('DELETE FROM list_items WHERE list_id = ?').run(id);
    this.touch(id);
    return this.get(id);
  }

  itemNames(id: number): string[] {
    this.summary(id);
    return (
      this.db
        .prepare('SELECT mod_name FROM list_items WHERE list_id = ? ORDER BY added_at, mod_name')
        .all(id) as { mod_name: string }[]
    ).map((r) => r.mod_name);
  }

  get(id: number): ListDetail {
    const list = this.summary(id);
    const rows = this.db
      .prepare(
        `SELECT i.mod_name, i.added_at, m.title, m.summary, m.latest_version, m.factorio_version,
                m.thumbnail, m.removed_at, m.deprecated
         FROM list_items i LEFT JOIN mods m ON m.name = i.mod_name
         WHERE i.list_id = ? ORDER BY i.added_at, i.mod_name COLLATE NOCASE`,
      )
      .all(id) as {
      mod_name: string;
      added_at: string;
      title: string | null;
      summary: string | null;
      latest_version: string | null;
      factorio_version: string | null;
      thumbnail: string | null;
      removed_at: string | null;
      deprecated: number | null;
    }[];

    const warnings: string[] = [];
    const items: ListItem[] = rows.map((r) => {
      const official = isOfficialMod(r.mod_name);
      if (!official && r.title === null)
        warnings.push(`"${r.mod_name}" is not in the local database.`);
      if (r.removed_at) warnings.push(`"${r.mod_name}" is no longer on the mod portal.`);
      if (r.deprecated) warnings.push(`"${r.mod_name}" is marked as deprecated by its author.`);
      return {
        name: r.mod_name,
        title: official ? officialTitle(r.mod_name) : (r.title ?? r.mod_name),
        official,
        known: official || r.title !== null,
        summary: r.summary ?? '',
        latestVersion: r.latest_version,
        factorioVersion: r.factorio_version,
        thumbnailUrl: this.thumbnailUrl(r.thumbnail),
        addedAt: r.added_at,
      };
    });

    // Incompatibilities between mods in the same list.
    const names = rows.map((r) => r.mod_name);
    if (names.length > 1) {
      const placeholders = names.map(() => '?').join(', ');
      const conflicts = this.db
        .prepare(
          `SELECT mod_name, dep_name FROM dependencies
           WHERE kind = 'incompatible' AND mod_name IN (${placeholders}) AND dep_name IN (${placeholders})`,
        )
        .all(...names, ...names) as { mod_name: string; dep_name: string }[];
      for (const c of conflicts)
        warnings.push(`"${c.mod_name}" is incompatible with "${c.dep_name}".`);
    }

    return { ...list, items, warnings };
  }

  private summary(id: number): ModList {
    const row = this.db.prepare(`${LIST_SELECT} WHERE l.id = ?`).get(id) as ListRow | undefined;
    if (!row) throw new ListNotFoundError(`List ${id} not found`);
    return toList(row);
  }

  private touch(id: number): void {
    this.db
      .prepare('UPDATE lists SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}
