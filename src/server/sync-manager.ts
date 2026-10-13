import type { Config } from '../core/config.js';
import type { DB } from '../core/db/connection.js';
import { getState } from '../core/db/connection.js';
import type { ThemeSearch } from '../core/embeddings/service.js';
import type { PortalClient } from '../core/portal/client.js';
import { runSync, type SyncProgress } from '../core/sync/sync.js';
import type { SyncStatus } from '../shared/types.js';

type ProgressState = Omit<SyncProgress, 'phase'> & { phase: SyncProgress['phase'] | 'embeddings' };

/** Runs at most one background sync inside the server process ("Refresh" button). */
export class SyncManager {
  private progress: ProgressState | null = null;
  private running: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private error: string | null = null;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly client: PortalClient,
    private readonly theme: ThemeSearch,
  ) {}

  start(opts: { gameVersion?: string } = {}): boolean {
    if (this.running) return false;
    this.error = null;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(opts.gameVersion, controller.signal)
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return true;
  }

  private async run(gameVersion: string | undefined, signal: AbortSignal): Promise<void> {
    const result = await runSync(this.db, this.client, {
      gameVersion: gameVersion ?? this.config.sync.gameVersion,
      staleDays: this.config.sync.staleDays,
      concurrency: this.config.portal.concurrency,
      signal,
      onProgress: (p) => (this.progress = p),
    });
    if (result.phase !== 'done' || !this.config.sync.embed || !this.theme.provider) return;

    const progress: ProgressState = {
      ...result,
      phase: 'embeddings',
      message: 'Updating theme index…',
    };
    this.progress = progress;
    try {
      await this.theme.update({
        signal,
        onProgress: (p) => {
          progress.queued = p.total;
          progress.done = p.done;
          progress.message = `Updating theme index ${p.done}/${p.total}`;
        },
      });
      progress.phase = 'done';
      progress.message = result.message;
    } catch (err) {
      // The catalogue refresh succeeded; only theme search is affected.
      progress.phase = 'done';
      this.error = `Theme index not updated: ${err instanceof Error ? err.message : String(err)}`;
    }
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
