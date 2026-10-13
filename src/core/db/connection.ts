import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  loadVectorExtension(db);
  migrate(db);
  return db;
}

const vectorSupport = new WeakMap<DB, string | null>();

/** Loads sqlite-vec. Failure is not fatal: only theme search becomes unavailable. */
function loadVectorExtension(db: DB): void {
  try {
    sqliteVec.load(db);
    vectorSupport.set(db, null);
  } catch (err) {
    vectorSupport.set(db, err instanceof Error ? err.message : String(err));
  }
}

/** Null when sqlite-vec is loaded, otherwise the reason it could not be. */
export function vectorSupportError(db: DB): string | null {
  return vectorSupport.has(db) ? vectorSupport.get(db)! : 'sqlite-vec not loaded';
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function getState(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function deleteState(db: DB, key: string): void {
  db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
}
