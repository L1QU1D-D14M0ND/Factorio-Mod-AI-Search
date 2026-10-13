import type { SyncStatus } from '../../../src/shared/types.ts';
import type { api as Api } from '../api.ts';
import { clear, h, timeAgo } from '../dom.ts';
import { clearDetailCache } from './detail.ts';
import { toast } from './toast.ts';

/** Shows when the catalogue was last refreshed and runs a manual, incremental refresh. */
export class SyncBar {
  readonly el = h('div', { class: 'sync' });
  private status: SyncStatus | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wasRunning = false;
  private lastRefresh = Date.now();

  constructor(
    private readonly client: typeof Api,
    private readonly onFinished: () => void,
  ) {}

  async poll(): Promise<void> {
    clearTimeout(this.timer);
    try {
      this.status = await this.client.syncStatus();
    } catch {
      this.status = null;
    }
    this.render();
    const running = !!this.status?.running;
    if (this.wasRunning && !running) {
      clearDetailCache();
      this.onFinished();
      if (this.status?.error) toast(`Refresh failed: ${this.status.error}`, 'error');
      else toast(this.status?.progress?.message ?? 'Refresh complete');
    }
    // While running, refresh results occasionally so new details show up.
    if (
      running &&
      this.status?.progress?.phase === 'details' &&
      Date.now() - this.lastRefresh > 15_000
    ) {
      this.lastRefresh = Date.now();
      this.onFinished();
    }
    this.wasRunning = running;
    if (running) this.timer = setTimeout(() => void this.poll(), 1000);
  }

  async start(): Promise<void> {
    try {
      this.status = await this.client.startSync();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    void this.poll();
  }

  private render(): void {
    const s = this.status;
    if (!s) {
      clear(this.el);
      return;
    }
    if (s.running) {
      const p = s.progress;
      const label =
        p?.phase === 'details' && p.queued
          ? `Fetching details ${p.done}/${p.queued}`
          : (p?.message ?? 'Starting…');
      const pct = p?.queued ? Math.round((p.done / p.queued) * 100) : 0;
      clear(
        this.el,
        h(
          'div',
          { class: 'progress', title: label },
          h('div', { class: 'bar', style: `width:${pct}%` }),
        ),
        h('span', { class: 'small' }, label),
        h(
          'button',
          { class: 'btn small ghost', onclick: () => void this.client.stopSync() },
          'Stop',
        ),
      );
      return;
    }
    const pending = s.pending ? ` · ${s.pending} pending` : '';
    clear(
      this.el,
      h(
        'span',
        { class: 'small muted', title: s.lastListSync ?? 'Never synced' },
        `Catalogue: ${timeAgo(s.lastListSync)}${pending}`,
      ),
      h(
        'button',
        {
          class: 'btn small',
          title: 'Download the latest mod list and fetch details for new or updated mods',
          onclick: () => void this.start(),
        },
        'Refresh',
      ),
    );
  }
}
