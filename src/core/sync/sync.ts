import type { DB } from '../db/connection.js';
import { deleteState, getState, setState } from '../db/connection.js';
import { compareVersions } from '../deps.js';
import { NotFoundError, type PortalClient } from '../portal/client.js';
import { applyFullMod, applyModList } from './apply.js';

export interface SyncOptions {
  /** "latest" or a major version like "2.0". Mods for this version or newer get full details. */
  gameVersion: string;
  /** Fetch details for every mod regardless of game version. */
  all?: boolean;
  /** Re-fetch details older than this many days (0 = never). */
  staleDays?: number;
  /** Only process the pending queue; do not re-download the mod list. */
  resumeOnly?: boolean;
  /** Stop after this many /full requests (handy for testing). */
  limit?: number;
  concurrency: number;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
}

export type SyncPhase = 'list' | 'details' | 'done' | 'aborted' | 'error';

export interface SyncProgress {
  phase: SyncPhase;
  startedAt: string;
  gameVersion: string | null;
  listed: number;
  added: number;
  changed: number;
  removed: number;
  /** Size of the /full queue when the details phase started. */
  queued: number;
  done: number;
  failed: number;
  current: string | null;
  message: string | null;
}

/** Drop a mod from the queue after this many failed /full attempts across runs. */
const MAX_ATTEMPTS = 5;
/** A lock whose heartbeat is older than this is considered abandoned (the list download can be slow). */
const LOCK_STALE_MS = 10 * 60_000;
/** "latest" ignores bogus versions (e.g. "6.9") that only a handful of mods declare. */
const MIN_MODS_FOR_LATEST = 25;

export class SyncLockedError extends Error {}

export function resolveGameVersion(db: DB, requested: string): string | null {
  if (requested !== 'latest') return requested;
  const rows = db
    .prepare(
      `SELECT factorio_version AS v FROM mods
       WHERE removed_at IS NULL AND factorio_version IS NOT NULL
       GROUP BY factorio_version HAVING COUNT(*) >= ?`,
    )
    .all(MIN_MODS_FOR_LATEST) as { v: string }[];
  return (
    rows
      .map((r) => r.v)
      .sort(compareVersions)
      .at(-1) ?? null
  );
}

function acquireLock(db: DB, owner: string): void {
  db.transaction(() => {
    const raw = getState(db, 'sync_lock');
    if (raw) {
      const lock = JSON.parse(raw) as { owner: string; heartbeat: number };
      if (Date.now() - lock.heartbeat < LOCK_STALE_MS) {
        throw new SyncLockedError('Another sync is already running.');
      }
    }
    setState(db, 'sync_lock', JSON.stringify({ owner, heartbeat: Date.now() }));
  }).immediate();
}

function heartbeat(db: DB, owner: string): void {
  setState(db, 'sync_lock', JSON.stringify({ owner, heartbeat: Date.now() }));
}

/** Queues mods that need a /full fetch. Returns the number of newly queued mods. */
function enqueue(
  db: DB,
  opts: Pick<SyncOptions, 'all' | 'staleDays'>,
  gameVersion: string | null,
  now: string,
): number {
  // "outdated": the latest release changed since the details were fetched.
  const rows = db
    .prepare(
      `SELECT name, factorio_version, full_synced_at, details_sha1 IS NOT latest_sha1 AS outdated
       FROM mods WHERE removed_at IS NULL`,
    )
    .all() as {
    name: string;
    factorio_version: string | null;
    full_synced_at: string | null;
    outdated: number;
  }[];
  const staleBefore = opts.staleDays
    ? new Date(Date.now() - opts.staleDays * 86_400_000).toISOString()
    : null;
  const insert = db.prepare(
    `INSERT INTO sync_queue (mod_name, reason, queued_at) VALUES (?, ?, ?)
     ON CONFLICT(mod_name) DO NOTHING`,
  );
  let count = 0;
  db.transaction(() => {
    for (const row of rows) {
      const inScope =
        opts.all ||
        !gameVersion ||
        (row.factorio_version !== null && compareVersions(row.factorio_version, gameVersion) >= 0);
      if (!inScope) continue;
      const reason = !row.full_synced_at
        ? 'missing'
        : row.outdated
          ? 'changed'
          : staleBefore && row.full_synced_at < staleBefore
            ? 'stale'
            : null;
      if (reason && insert.run(row.name, reason, now).changes > 0) count++;
    }
  })();
  return count;
}

/**
 * Incremental sync:
 *  1. Download the full mod list (one request) and upsert summary fields.
 *  2. Queue /full fetches for in-scope mods that are new, changed, or never detailed.
 *  3. Drain the queue with throttled requests. The queue lives in the DB, so an
 *     interrupted run resumes where it stopped.
 */
export async function runSync(
  db: DB,
  client: PortalClient,
  opts: SyncOptions,
): Promise<SyncProgress> {
  const owner = `${process.pid}-${Date.now()}`;
  acquireLock(db, owner);

  const progress: SyncProgress = {
    phase: 'list',
    startedAt: new Date().toISOString(),
    gameVersion: null,
    listed: 0,
    added: 0,
    changed: 0,
    removed: 0,
    queued: 0,
    done: 0,
    failed: 0,
    current: null,
    message: null,
  };
  let lastBeat = Date.now();
  const emit = () => {
    if (Date.now() - lastBeat > 10_000) {
      heartbeat(db, owner);
      lastBeat = Date.now();
    }
    opts.onProgress?.({ ...progress });
  };

  try {
    if (!opts.resumeOnly) {
      progress.message = 'Downloading mod list…';
      emit();
      const list = await client.listAllMods();
      const now = new Date().toISOString();
      const applied = applyModList(db, list.results ?? [], now);
      Object.assign(progress, {
        listed: applied.listed,
        added: applied.added.length,
        changed: applied.changed.length,
        removed: applied.removed.length,
      });
      setState(db, 'last_list_sync', now);
    }

    progress.gameVersion = resolveGameVersion(db, opts.gameVersion);
    if (!opts.resumeOnly) {
      enqueue(db, opts, progress.gameVersion, new Date().toISOString());
    }
    setState(db, 'sync_game_version', progress.gameVersion ?? '');

    // Most-downloaded first, so a partial sync is useful sooner.
    const queue = (
      db
        .prepare(
          `SELECT q.mod_name FROM sync_queue q LEFT JOIN mods m ON m.name = q.mod_name
           ORDER BY m.downloads_count DESC`,
        )
        .all() as { mod_name: string }[]
    ).map((r) => r.mod_name);
    const todo = opts.limit ? queue.slice(0, opts.limit) : queue;

    progress.phase = 'details';
    progress.queued = todo.length;
    progress.message = todo.length ? `Fetching details for ${todo.length} mods…` : 'Up to date.';
    emit();

    const dequeue = db.prepare('DELETE FROM sync_queue WHERE mod_name = ?');
    const markFailed = db.prepare(
      'UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE mod_name = ?',
    );
    const dropExhausted = db.prepare('DELETE FROM sync_queue WHERE attempts >= ?');
    const markRemoved = db.prepare('UPDATE mods SET removed_at = ? WHERE name = ?');

    let index = 0;
    const worker = async () => {
      while (index < todo.length && !opts.signal?.aborted) {
        const name = todo[index++]!;
        progress.current = name;
        try {
          const mod = await client.getFullMod(name);
          applyFullMod(db, { ...mod, name }, new Date().toISOString());
          dequeue.run(name);
        } catch (err) {
          if (err instanceof NotFoundError) {
            markRemoved.run(new Date().toISOString(), name);
            dequeue.run(name);
          } else {
            progress.failed++;
            markFailed.run(err instanceof Error ? err.message : String(err), name);
          }
        }
        progress.done++;
        emit();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
    dropExhausted.run(MAX_ATTEMPTS);

    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as { n: number }).n;
    progress.current = null;
    if (opts.signal?.aborted) {
      progress.phase = 'aborted';
      progress.message = `Stopped. ${remaining} mods still queued; run sync again to resume.`;
    } else {
      progress.phase = 'done';
      progress.message = remaining
        ? `Finished with ${remaining} mods still queued (failed or over --limit).`
        : 'Sync complete.';
      setState(db, 'last_sync_completed', new Date().toISOString());
    }
    emit();
    return progress;
  } catch (err) {
    progress.phase = 'error';
    progress.message = err instanceof Error ? err.message : String(err);
    emit();
    throw err;
  } finally {
    deleteState(db, 'sync_lock');
  }
}
