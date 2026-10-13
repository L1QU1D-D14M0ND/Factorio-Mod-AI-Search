import type { Config } from '../core/config.js';
import type { DB } from '../core/db/connection.js';
import { getState } from '../core/db/connection.js';
import { PortalClient } from '../core/portal/client.js';
import { runSync, type SyncProgress } from '../core/sync/sync.js';
import type { SyncStatus } from '../shared/types.js';

/** Runs at most one background sync inside the server process ("Refresh" button). */
export class SyncManager {
  private progress: SyncProgress | null = null;
  private running: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private error: string | null = null;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
  ) {}

  start(opts: { gameVersion?: string } = {}): boolean {
    if (this.running) return false;
    this.error = null;
    this.controller = new AbortController();
    this.running = runSync(this.db, new PortalClient(this.config.portal), {
      gameVersion: opts.gameVersion ?? this.config.sync.gameVersion,
      staleDays: this.config.sync.staleDays,
      concurrency: this.config.portal.concurrency,
      signal: this.controller.signal,
      onProgress: (p) => (this.progress = p),
    })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return true;
  }

  stop(): void {
    this.controller?.abort();
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.running;
  }

  status(): SyncStatus {
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as { n: number })
      .n;
    const p = this.progress;
    return {
      running: this.running !== null,
      progress: p
        ? { phase: p.phase, queued: p.queued, done: p.done, failed: p.failed, message: p.message }
        : null,
      lastListSync: getState(this.db, 'last_list_sync'),
      lastCompleted: getState(this.db, 'last_sync_completed'),
      gameVersion: getState(this.db, 'sync_game_version') || null,
      pending,
      error: this.error,
    };
  }
}
