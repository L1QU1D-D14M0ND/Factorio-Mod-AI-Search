import { serve } from '@hono/node-server';
import { loadConfig } from '../core/config.js';
import { openDatabase } from '../core/db/connection.js';
import { PortalClient } from '../core/portal/client.js';
import { createApp } from './app.js';
import { DetailsFetcher } from './details.js';
import { Services } from './services.js';
import { SyncManager } from './sync-manager.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
// One client (and so one rate limiter) for background syncs and on-demand details.
const client = new PortalClient(config.portal);
const services = new Services(db);
const sync = new SyncManager(db, services, client);
const details = new DetailsFetcher(db, client);
const app = createApp({ db, services, sync, details });

const { n } = db.prepare('SELECT COUNT(*) AS n FROM mods').get() as { n: number };

const server = serve(
  { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
  (info) => {
    const host = info.address.includes(':') ? `[${info.address}]` : info.address;
    console.log(
      `Factorio Mod Finder running at http://${host === '127.0.0.1' ? 'localhost' : host}:${info.port}`,
    );
    console.log(`Database: ${config.dbPath} (${n} mods)`);
    if (n === 0)
      console.log('The database is empty: run "npm run sync" or press Refresh in the UI.');
    const status = services.theme.status();
    console.log(
      status.ready
        ? `Theme search: ${status.provider} (${status.indexed} mods)`
        : `Theme search: off. ${status.reason}`,
    );
    const llm = services.llm;
    console.log('error' in llm ? `AI search: off (${llm.error})` : `AI search: ${llm.id}`);
    // Load the embedding model in the background so the first theme search is fast.
    if (status.ready) void services.theme.queryVector('factorio').catch(() => {});
  },
);

let closing = false;
const shutdown = async () => {
  if (closing) process.exit(1);
  closing = true;
  await sync.shutdown();
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
