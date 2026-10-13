import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { ThemeSearch } from '../src/core/embeddings/service.js';
import { NotFoundError, type PortalClient } from '../src/core/portal/client.js';
import type { PortalFullMod } from '../src/core/portal/types.js';
import { createApp } from '../src/server/app.js';
import { DetailsFetcher } from '../src/server/details.js';
import type { SyncManager } from '../src/server/sync-manager.js';
import type { ModDetail, SearchResponse } from '../src/shared/types.js';
import { fullMod, listEntry, seedDb } from './helpers.js';

function setup(full: Record<string, PortalFullMod>) {
  const train = listEntry('train-mod', { title: 'Train Mod', summary: 'Trains', factorio: '1.1' });
  const db = seedDb([{ entry: train }, { entry: listEntry('gone') }]);
  const fetched: string[] = [];
  const client = {
    getFullMod: async (name: string) => {
      fetched.push(name);
      if (!full[name]) throw new NotFoundError(name);
      return full[name];
    },
  } as unknown as PortalClient;
  const config = loadConfig('/nonexistent', { FMF_EMBEDDINGS_PROVIDER: 'none' });
  const app = createApp({
    db,
    config,
    sync: {} as SyncManager,
    theme: new ThemeSearch(db, config.embeddings),
    details: new DetailsFetcher(db, client),
  });
  return { app, fetched, train };
}

describe('HTTP API', () => {
  it('falls back to keyword search when theme search is unavailable', async () => {
    const { app } = setup({});
    const res = await app.request('http://localhost/api/mods?semantic=train');
    const body = (await res.json()) as SearchResponse;
    expect(body.notice).toMatch(/Theme search unavailable/);
    expect(body.items.map((m) => m.name)).toEqual(['train-mod']);
  });

  it('fetches missing details when a mod is opened, once', async () => {
    const { app, fetched, train } = setup({});
    const full = fullMod(train, { description: 'Long description', tags: ['trains'] });
    const withDetails = setup({ 'train-mod': full });
    const res = await withDetails.app.request('http://localhost/api/mods/train-mod');
    const mod = (await res.json()) as ModDetail;
    expect(mod.description).toBe('Long description');
    expect(mod.tags).toEqual(['trains']);
    expect(mod.detailsError).toBeUndefined();
    await withDetails.app.request('http://localhost/api/mods/train-mod');
    expect(withDetails.fetched).toEqual(['train-mod']);

    // Portal says 404: reported, and the mod is marked as removed.
    const gone = (await (await app.request('http://localhost/api/mods/gone')).json()) as ModDetail;
    expect(gone.detailsError).toMatch(/no longer on the mod portal/);
    expect(gone.removed).toBe(true);
    expect(fetched).toEqual(['gone']);
  });

  it('refuses foreign hosts and cross-site writes', async () => {
    const { app } = setup({});
    expect((await app.request('http://evil.example/api/health')).status).toBe(403);
    const res = await app.request('http://localhost/api/lists', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });
});
