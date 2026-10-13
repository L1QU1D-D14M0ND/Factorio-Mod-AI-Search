import type { DB } from '../core/db/connection.js';
import { NotFoundError, type PortalClient } from '../core/portal/client.js';
import { applyFullMod } from '../core/sync/apply.js';

/**
 * Fetches a mod's full details from the portal when someone opens it and they are
 * missing or outdated (e.g. mods outside the synced game version). One request, only
 * on user action, sharing the sync's rate limiter.
 */
export class DetailsFetcher {
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly db: DB,
    private readonly client: PortalClient,
  ) {}

  /** Returns null when details are available, otherwise a user-facing error message. */
  ensure(name: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT full_synced_at IS NOT NULL AS has_details,
                details_sha1 IS NOT latest_sha1 AS outdated, removed_at
         FROM mods WHERE name = ?`,
      )
      .get(name) as
      { has_details: number; outdated: number; removed_at: string | null } | undefined;
    if (!row || row.removed_at || (row.has_details && !row.outdated)) return Promise.resolve(null);

    let pending = this.inflight.get(name);
    if (!pending) {
      pending = this.fetch(name).finally(() => this.inflight.delete(name));
      this.inflight.set(name, pending);
    }
    return pending;
  }

  private async fetch(name: string): Promise<string | null> {
    try {
      const mod = await this.client.getFullMod(name, { interactive: true });
      applyFullMod(this.db, { ...mod, name }, new Date().toISOString());
      this.db.prepare('DELETE FROM sync_queue WHERE mod_name = ?').run(name);
      return null;
    } catch (err) {
      if (err instanceof NotFoundError) {
        this.db
          .prepare('UPDATE mods SET removed_at = ? WHERE name = ?')
          .run(new Date().toISOString(), name);
        return 'This mod is no longer on the mod portal.';
      }
      return `Could not load full details from the mod portal (${err instanceof Error ? err.message : String(err)}).`;
    }
  }
}
