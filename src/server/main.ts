import { serve } from '@hono/node-server';
import { loadConfig } from '../core/config.js';
import { openDatabase } from '../core/db/connection.js';
import { createApp } from './app.js';
import { SyncManager } from './sync-manager.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const sync = new SyncManager(db, config);
const app = createApp({ db, config, sync });

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
