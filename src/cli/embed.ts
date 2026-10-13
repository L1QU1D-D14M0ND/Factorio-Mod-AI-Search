import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.js';
import { openDatabase } from '../core/db/connection.js';
import { ThemeSearch } from '../core/embeddings/service.js';
import { embedWithProgress } from './embed-progress.js';

const HELP = `Usage: npm run embed -- [options]

Builds or updates the theme-search index: one embedding per mod (title + summary).
Only new or changed mods are embedded; switching models rebuilds everything.

Options:
  --rebuild   Drop the index and embed every mod again
  -h, --help  Show this help
`;

const { values } = parseArgs({
  options: {
    rebuild: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const config = loadConfig();
const db = openDatabase(config.dbPath);
const theme = new ThemeSearch(db, config.embeddings);
if (!theme.provider) {
  console.log('Theme search is disabled (embeddings.provider = "none").');
  process.exit(0);
}

const controller = new AbortController();
process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(130);
  console.log('\nStopping after the current batch…');
  controller.abort();
});

console.log(`Embedding model: ${theme.provider.id}`);
if (config.embeddings.provider === 'transformers') {
  console.log(`(The model is downloaded to ${config.embeddings.cacheDir} on first use.)`);
}
const started = Date.now();
try {
  await embedWithProgress(theme, { rebuild: values.rebuild, signal: controller.signal });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
} catch (err) {
  console.error('\nEmbedding failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
