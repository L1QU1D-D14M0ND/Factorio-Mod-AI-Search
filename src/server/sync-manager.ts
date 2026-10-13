import type { DB } from '../core/db/connection.js';
import { getState } from '../core/db/connection.js';
import type { PortalClient } from '../core/portal/client.js';
import { runSync, type SyncProgress } from '../core/sync/sync.js';
import type { SyncStatus } from '../shared/types.js';
import type { Services } from './services.js';

type ProgressState = Omit<SyncProgress, 'phase'> & { phase: SyncProgress['phase'] | 'embeddings' };

/** Runs at most one background sync inside the server process ("Refresh" button). */
export class SyncManager {
  private progress: ProgressState | null = null;
  private running: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private error: string | null = null;

  constructor(
    private readonly db: DB,
    private readonly services: Services,
    private readonly client: PortalClient,
  ) {}

  /**
   * Starts a background job: a full refresh (sync + theme index), or with `embedOnly`
   * just the theme index (e.g. after changing the embedding model in Settings).
   */
  start(opts: { gameVersion?: string; embedOnly?: boolean; rebuild?: boolean } = {}): boolean {
    if (this.running) return false;
    this.error = null;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(opts, controller.signal)
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return true;
  }

  private async run(
    opts: { gameVersion?: string; embedOnly?: boolean; rebuild?: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    const { config, theme } = this.services;
    let finalMessage = 'Theme index updated.';
    let base: Omit<ProgressState, 'phase' | 'message'> = {
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
    };
    if (!opts.embedOnly) {
      const result = await runSync(this.db, this.client, {
        gameVersion: opts.gameVersion ?? config.sync.gameVersion,
        staleDays: config.sync.staleDays,
        concurrency: config.portal.concurrency,
        signal,
        onProgress: (p) => (this.progress = p),
      });
      if (result.phase !== 'done' || !config.sync.embed) return;
      base = result;
      finalMessage = result.message ?? finalMessage;
    }
    if (!theme.provider) return;

    const progress: ProgressState = {
      ...base,
      phase: 'embeddings',
      message: 'Updating theme index…',
    };
    this.progress = progress;
    try {
      await theme.update({
        rebuild: opts.rebuild,
        signal,
        onProgress: (p) => {
          progress.queued = p.total;
          progress.done = p.done;
          progress.message = `Updating theme index ${p.done}/${p.total}`;
        },
      });
      progress.phase = 'done';
      progress.message = finalMessage;
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
