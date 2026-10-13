import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/db/connection.js';
import { NotFoundError, type PortalClient } from '../src/core/portal/client.js';
import type { PortalFullMod, PortalListEntry } from '../src/core/portal/types.js';
import { resolveGameVersion, runSync } from '../src/core/sync/sync.js';
import { fullMod, listEntry, seedDb } from './helpers.js';

function fakeClient(list: PortalListEntry[], full: Record<string, PortalFullMod>) {
  const fetched: string[] = [];
  const client = {
    listAllMods: async () => ({ pagination: null, results: list }),
    getFullMod: async (name: string) => {
      fetched.push(name);
      const mod = full[name];
      if (!mod) throw new NotFoundError(name);
      return mod;
    },
  } as unknown as PortalClient;
  return { client, fetched };
}

const opts = { gameVersion: 'latest', concurrency: 2 };

describe('runSync', () => {
  it('fetches details only for in-scope mods, then only for changed ones', async () => {
    const db = openDatabase(':memory:');
    const a = listEntry('a', { factorio: '2.0' });
    const b = listEntry('b', { factorio: '1.1' });
    const c = listEntry('c', { factorio: '2.0', requires_space_age: true });
    const full = { a: fullMod(a), b: fullMod(b), c: fullMod(c, { dependencies: ['space-age'] }) };

    const first = fakeClient([a, b, c], full);
    const r1 = await runSync(db, first.client, { ...opts, gameVersion: '2.0' });
    expect(r1.phase).toBe('done');
    expect(first.fetched.sort()).toEqual(['a', 'c']);
    expect(r1.added).toBe(3);

    // Nothing changed: no /full requests.
    const second = fakeClient([a, b, c], full);
    const r2 = await runSync(db, second.client, { ...opts, gameVersion: '2.0' });
    expect(second.fetched).toEqual([]);
    expect(r2.changed).toBe(0);

    // New release for "a", "c" disappears from the portal.
    const a2 = listEntry('a', { version: '1.1.0', factorio: '2.0' });
    const third = fakeClient([a2, b], { ...full, a: fullMod(a2) });
    const r3 = await runSync(db, third.client, { ...opts, gameVersion: '2.0' });
    expect(third.fetched).toEqual(['a']);
    expect(r3.changed).toBe(1);
    expect(r3.removed).toBe(1);
    const c3 = db
      .prepare('SELECT removed_at, requires_space_age FROM mods WHERE name = ?')
      .get('c');
    expect(c3).toMatchObject({ requires_space_age: 1 });
    expect((c3 as { removed_at: string | null }).removed_at).not.toBeNull();
  });

  it('keeps failed mods queued for the next run', async () => {
    const db = openDatabase(':memory:');
    const a = listEntry('a');
    const failing = {
      listAllMods: async () => ({ pagination: null, results: [a] }),
      getFullMod: async () => {
        throw new Error('HTTP 503');
      },
    } as unknown as PortalClient;
    const r = await runSync(db, failing, { ...opts, gameVersion: '2.0' });
    expect(r.failed).toBe(1);
    expect(db.prepare('SELECT attempts FROM sync_queue').all()).toEqual([{ attempts: 1 }]);

    const ok = fakeClient([a], { a: fullMod(a) });
    await runSync(db, ok.client, { ...opts, gameVersion: '2.0', resumeOnly: true });
    expect(ok.fetched).toEqual(['a']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get()).toEqual({ n: 0 });
  });

  it('resolves "latest" ignoring rare bogus versions', () => {
    const db = seedDb([
      ...Array.from({ length: 30 }, (_, i) => ({ entry: listEntry(`x${i}`, { factorio: '2.0' }) })),
      ...Array.from({ length: 30 }, (_, i) => ({ entry: listEntry(`y${i}`, { factorio: '1.1' }) })),
      { entry: listEntry('weird', { factorio: '6.9' }) },
    ]);
    expect(resolveGameVersion(db, 'latest')).toBe('2.0');
    expect(resolveGameVersion(db, '1.1')).toBe('1.1');
  });
});
