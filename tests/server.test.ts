import { describe, expect, it } from 'vitest';
import { NotFoundError, type PortalClient } from '../src/core/portal/client.js';
import type { PortalFullMod } from '../src/core/portal/types.js';
import { createApp } from '../src/server/app.js';
import { DetailsFetcher } from '../src/server/details.js';
import { Services } from '../src/server/services.js';
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
  const services = new Services(db, '/nonexistent', { FMF_EMBEDDINGS_PROVIDER: 'none' });
  const app = createApp({
    db,
    services,
    sync: {} as SyncManager,
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

describe('AI search and settings API', () => {
  async function tmpServices() {
    const { mkdtempSync, readFileSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fmf-'));
    const db = seedDb([{ entry: listEntry('train-mod', { title: 'Train Mod' }) }]);
    const services = new Services(db, dir, {
      FMF_EMBEDDINGS_PROVIDER: 'none',
      FMF_LLM_BASE_URL: 'http://127.0.0.1:9/v1',
    });
    const app = createApp({ db, services, sync: {} as SyncManager, details: {} as DetailsFetcher });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`http://localhost${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return {
      services,
      call,
      read: () => readFileSync(join(dir, 'config.json'), 'utf8'),
      mode: () => statSync(join(dir, 'config.json')).mode & 0o777,
    };
  }

  it('explains when no AI provider is configured', async () => {
    const { call } = await tmpServices();
    const res = await call('POST', '/api/ask', { prompt: 'train mods' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No AI provider/);
  });

  it('returns the interpreted filter from the model', async () => {
    const { services, call } = await tmpServices();
    services.llm = {
      id: 'fake',
      structured: async () => ({ explanation: 'Trains', semantic: 'trains', tags: ['nope'] }),
      listModels: async () => [],
    };
    const res = await call('POST', '/api/ask', { prompt: 'train mods' });
    expect(await res.json()).toEqual({
      filter: { semantic: 'trains' },
      explanation: 'Trains',
      ignored: ['tags'],
    });
  });

  it('saves settings to config.json without ever returning the key', async () => {
    const { call, read, mode } = await tmpServices();
    const res = await call('PUT', '/api/settings', {
      llm: { provider: 'anthropic', apiKey: 'sk-ant-secret', model: '' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-ant-secret');
    const body = JSON.parse(text) as {
      llm: { provider: string; apiKeySet: boolean; locked: string[] };
      status: { llm: { ready: boolean; message: string } };
    };
    expect(body.llm).toMatchObject({ provider: 'anthropic', apiKeySet: true, locked: ['baseUrl'] });
    expect(body.status.llm).toEqual({ ready: true, message: 'anthropic:claude-haiku-5-5' });
    expect(JSON.parse(read())).toEqual({ llm: { provider: 'anthropic', apiKey: 'sk-ant-secret' } });
    if (process.platform !== 'win32') expect(mode()).toBe(0o600);

    // Clearing the key removes it from the file.
    await call('PUT', '/api/settings', { llm: { apiKey: null } });
    expect(JSON.parse(read())).toEqual({ llm: { provider: 'anthropic' } });
  });

  it('refuses to change fields fixed by environment variables', async () => {
    const { call } = await tmpServices();
    const res = await call('PUT', '/api/settings', { llm: { baseUrl: 'http://example.com/v1' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/environment variable/);
  });

  it('reports connection test failures without throwing', async () => {
    const { call } = await tmpServices();
    const res = await call('POST', '/api/settings/test', {
      section: 'llm',
      draft: { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'x' },
    });
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/Could not reach/);
  });
});
