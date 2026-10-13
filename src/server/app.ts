import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { DB } from '../core/db/connection.js';
import { EXPORT_FORMATS, renderExport } from '../core/export/formats.js';
import { resolveList } from '../core/export/resolve.js';
import { ListNotFoundError, ListRepository } from '../core/lists.js';
import { ModRepository } from '../core/repo.js';
import { filterFromSearchParams, ModFilterSchema } from '../shared/filters.js';
import { explainResults, interpretRequest } from '../core/llm/nl-search.js';
import { LlmError } from '../core/llm/providers.js';
import type { AskResponse, ExplainResponse } from '../shared/types.js';
import type { DetailsFetcher } from './details.js';
import type { Services } from './services.js';
import {
  applySettings,
  DraftSchema,
  listModels,
  publicSettings,
  SettingsError,
  SettingsPatchSchema,
  testSettings,
} from './settings.js';
import type { SyncManager } from './sync-manager.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const ListNameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const AddItemsSchema = z.object({
  names: z.array(z.string().trim().min(1).max(100)).min(1).max(500),
});
const AskSchema = z.object({ prompt: z.string().trim().min(2).max(500) });
const ExplainSchema = z.object({
  prompt: z.string().trim().min(2).max(500),
  names: z.array(z.string().min(1).max(100)).min(1).max(10),
});
const ThemeRebuildSchema = z.object({ rebuild: z.boolean().optional() });

/** True when the TCP peer is this machine. Settings (API keys) are only editable locally. */
function isLocalRequest(c: Context): boolean {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    return true; // not running on the Node server (e.g. in tests)
  }
  return (
    !address || address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
  );
}

const SyncStartSchema = z.object({
  gameVersion: z
    .string()
    .regex(/^(latest|\d+\.\d+)$/)
    .optional(),
});

export interface AppDeps {
  db: DB;
  services: Services;
  sync: SyncManager;
  details: DetailsFetcher;
}

export function createApp({ db, services, sync, details }: AppDeps): Hono {
  const { config } = services; // server and portal settings are fixed at startup
  const app = new Hono();
  const mods = new ModRepository(db, {
    assetsUrl: config.portal.assetsUrl,
    portalUrl: config.portal.baseUrl,
  });
  const lists = new ListRepository(db, (p) => mods.thumbnailUrl(p));

  // This is a local app: refuse requests whose Host is not loopback (DNS rebinding) and
  // cross-site writes (CSRF from other websites open in the browser).
  app.use('/api/*', async (c, next) => {
    if (LOOPBACK_HOSTS.has(config.server.host)) {
      const host = new URL(c.req.url).hostname;
      if (!LOOPBACK_HOSTS.has(host)) return c.json({ error: 'Forbidden host' }, 403);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && !LOOPBACK_HOSTS.has(new URL(origin).hostname)) {
        return c.json({ error: 'Cross-origin request refused' }, 403);
      }
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: 'Invalid request', issues: err.issues }, 400);
    }
    if (err instanceof ListNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof SettingsError) return c.json({ error: err.message }, 400);
    if (err instanceof LlmError) return c.json({ error: err.message }, 502);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  const listId = (c: Context) => z.coerce.number().int().positive().parse(c.req.param('id'));
  const body = async <T>(c: Context, schema: z.ZodType<T>) =>
    schema.parse(await c.req.json().catch(() => ({})));

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/mods', async (c) => {
    const filter = ModFilterSchema.parse(filterFromSearchParams(new URL(c.req.url).searchParams));
    if (!filter.semantic) return c.json(mods.search(filter));
    try {
      const vector = await services.theme.queryVector(filter.semantic);
      return c.json(mods.search(filter, { vector, k: services.config.embeddings.candidates }));
    } catch (err) {
      // Theme search unavailable: fall back to keyword search on the same text.
      const fallback = { ...filter, semantic: undefined, q: filter.q ?? filter.semantic };
      const notice = `Theme search unavailable, showing keyword results instead. ${err instanceof Error ? err.message : ''}`;
      return c.json({ ...mods.search(fallback), notice: notice.trim() });
    }
  });

  app.get('/api/mods/:name', async (c) => {
    const name = c.req.param('name');
    const detailsError = await details.ensure(name);
    const mod = mods.getMod(name);
    if (!mod) return c.json({ error: 'Mod not found' }, 404);
    return c.json(detailsError ? { ...mod, detailsError } : mod);
  });

  app.get('/api/theme', (c) => c.json(services.theme.status()));
  app.post('/api/theme/rebuild', async (c) => {
    const { rebuild } = await body(c, ThemeRebuildSchema);
    const started = sync.start({ embedOnly: true, rebuild });
    return c.json(sync.status(), started ? 202 : 409);
  });

  // --- Natural-language search -------------------------------------------------
  // The LLM only turns the request into a filter; the search itself runs here.

  const chat = () => {
    if ('error' in services.llm) throw new SettingsError(services.llm.error);
    return services.llm;
  };

  app.post('/api/ask', async (c) => {
    const { prompt } = await body(c, AskSchema);
    const llm = chat();
    const facets = mods.facets();
    const result = await interpretRequest(llm, prompt, {
      tags: facets.tags.map((t) => t.value),
      factorioVersions: facets.factorioVersions.map((v) => v.value),
      today: new Date().toISOString().slice(0, 10),
    });
    return c.json(result satisfies AskResponse);
  });

  app.post('/api/ask/explain', async (c) => {
    const { prompt, names } = await body(c, ExplainSchema);
    const llm = chat();
    const candidates = mods.summaries(names);
    const ranking = await explainResults(llm, prompt, candidates);
    const titles = new Map(candidates.map((m) => [m.name, m.title]));
    return c.json({
      ranking: ranking.map((r) => ({ ...r, title: titles.get(r.name) ?? r.name })),
    } satisfies ExplainResponse);
  });

  // --- Settings (local requests only: they can contain API keys) ----------------

  const localOnly: MiddlewareHandler = async (c, next) => {
    if (!isLocalRequest(c)) {
      return c.json({ error: 'Settings can only be changed from this computer.' }, 403);
    }
    await next();
  };
  app.use('/api/settings', localOnly);
  app.use('/api/settings/*', localOnly);
  app.get('/api/settings', (c) => c.json(publicSettings(services)));
  app.put('/api/settings', async (c) => {
    applySettings(services, await body(c, SettingsPatchSchema));
    return c.json(publicSettings(services));
  });
  app.post('/api/settings/test', async (c) => {
    try {
      return c.json({
        ok: true,
        message: await testSettings(services, await body(c, DraftSchema)),
      });
    } catch (err) {
      if (err instanceof z.ZodError) throw err;
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/settings/models', async (c) => {
    return c.json({ models: await listModels(services, await body(c, DraftSchema)) });
  });

  app.get('/api/facets', (c) => c.json(mods.facets()));

  app.get('/api/sync', (c) => c.json(sync.status()));
  app.post('/api/sync', async (c) => {
    const { gameVersion } = await body(c, SyncStartSchema);
    const started = sync.start({ gameVersion });
    return c.json(sync.status(), started ? 202 : 409);
  });
  app.post('/api/sync/stop', (c) => {
    sync.stop();
    return c.json(sync.status());
  });

  app.get('/api/lists', (c) => c.json(lists.all()));
  app.post('/api/lists', async (c) => {
    const { name } = await body(c, ListNameSchema);
    return c.json(lists.create(name), 201);
  });
  app.get('/api/lists/:id', (c) => c.json(lists.get(listId(c))));
  app.patch('/api/lists/:id', async (c) => {
    const { name } = await body(c, ListNameSchema);
    return c.json(lists.rename(listId(c), name));
  });
  app.delete('/api/lists/:id', (c) => {
    lists.remove(listId(c));
    return c.body(null, 204);
  });
  app.post('/api/lists/:id/items', async (c) => {
    const { names } = await body(c, AddItemsSchema);
    return c.json(lists.addItems(listId(c), names));
  });
  app.delete('/api/lists/:id/items', (c) => c.json(lists.clear(listId(c))));
  app.delete('/api/lists/:id/items/:name', (c) =>
    c.json(lists.removeItem(listId(c), c.req.param('name'))),
  );

  app.get('/api/lists/:id/export', (c) => {
    const id = listId(c);
    const format = z.enum(EXPORT_FORMATS).parse(c.req.query('format') ?? 'txt');
    const includeDeps = c.req.query('deps') !== '0';
    const list = lists.get(id);
    const resolved = resolveList(db, lists.itemNames(id), includeDeps);
    const file = renderExport(format, {
      listName: list.name,
      mods: resolved.mods,
      warnings: resolved.warnings,
      portalUrl: config.portal.baseUrl,
      generatedAt: new Date(),
    });
    return c.body(file.body, 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // Built web UI (npm run build:web). In development Vite serves it instead.
  if (existsSync(WEB_DIST)) {
    app.use('/*', serveStatic({ root: WEB_DIST }));
    app.get('/*', serveStatic({ root: WEB_DIST, path: 'index.html' }));
  } else {
    app.get('/', (c) =>
      c.text('Web UI not built. Run "npm run build:web" or use "npm run dev" for development.'),
    );
  }

  return app;
}
