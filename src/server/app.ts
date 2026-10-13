import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db/connection.js';
import { EXPORT_FORMATS, renderExport } from '../core/export/formats.js';
import { resolveList } from '../core/export/resolve.js';
import { ListNotFoundError, ListRepository } from '../core/lists.js';
import { ModRepository } from '../core/repo.js';
import { filterFromSearchParams, ModFilterSchema } from '../shared/filters.js';
import type { ThemeSearch } from '../core/embeddings/service.js';
import type { DetailsFetcher } from './details.js';
import type { SyncManager } from './sync-manager.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const ListNameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const AddItemsSchema = z.object({
  names: z.array(z.string().trim().min(1).max(100)).min(1).max(500),
});
const SyncStartSchema = z.object({
  gameVersion: z
    .string()
    .regex(/^(latest|\d+\.\d+)$/)
    .optional(),
});

export interface AppDeps {
  db: DB;
  config: Config;
  sync: SyncManager;
  theme: ThemeSearch;
  details: DetailsFetcher;
}

export function createApp({ db, config, sync, theme, details }: AppDeps): Hono {
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
      const vector = await theme.queryVector(filter.semantic);
      return c.json(mods.search(filter, { vector, k: config.embeddings.candidates }));
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

  app.get('/api/theme', (c) => c.json(theme.status()));

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
