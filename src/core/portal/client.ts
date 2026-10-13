import type { Config } from '../config.js';
import type { PortalFullMod, PortalListResponse } from './types.js';

export class NotFoundError extends Error {}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`HTTP ${status} for ${path}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spaces out request starts so that at most `perSecond` begin per second,
 * regardless of how many callers run concurrently.
 */
export class RateLimiter {
  private next = 0;
  constructor(private readonly perSecond: number) {}

  async acquire(): Promise<void> {
    const interval = 1000 / this.perSecond;
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + interval;
    if (slot > now) await sleep(slot - now);
  }

  /** Push every future slot back, e.g. after a 429. */
  pause(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class PortalClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly config: Config['portal'],
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.limiter = new RateLimiter(config.requestsPerSecond);
  }

  /** Every mod on the portal in a single request (including deprecated ones). */
  listAllMods(): Promise<PortalListResponse> {
    return this.getJson<PortalListResponse>('/api/mods?page_size=max&hide_deprecated=false');
  }

  getFullMod(name: string): Promise<PortalFullMod> {
    return this.getJson<PortalFullMod>(`/api/mods/${encodeURIComponent(name)}/full`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = this.config.baseUrl + path;
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.config.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (res.ok) return (await res.json()) as T;
        if (res.status === 404) throw new NotFoundError(`Not found: ${path}`);
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 0) retryAfterMs = retryAfter * 1000;
        throw new HttpError(res.status, path);
      } catch (err) {
        const retryable =
          !(err instanceof NotFoundError) &&
          (!(err instanceof HttpError) || err.status === 429 || err.status >= 500);
        if (!retryable || attempt >= this.config.maxRetries) throw err;
      }
      // Exponential backoff with jitter; also delays every other queued request.
      this.limiter.pause(
        retryAfterMs ?? Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250,
      );
    }
  }
}
