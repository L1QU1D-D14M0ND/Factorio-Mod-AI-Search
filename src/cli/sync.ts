import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.js';
import { openDatabase } from '../core/db/connection.js';
import { PortalClient } from '../core/portal/client.js';
import { runSync, SyncLockedError, type SyncProgress } from '../core/sync/sync.js';

const HELP = `Usage: npm run sync -- [options]

Downloads the mod list from the Factorio mod portal and fetches full details
(description, tags, dependencies) for new or changed mods. Safe to interrupt
with Ctrl+C and re-run: it resumes where it stopped.

Options:
  --game-version <v>  Fetch details for mods targeting this Factorio version or newer
                      ("latest" or e.g. "2.0"). Default from config: sync.gameVersion
  --all               Fetch details for every mod, regardless of game version
  --stale-days <n>    Also re-fetch details older than n days (0 = never)
  --resume            Only drain the pending queue; skip the mod list download
  --limit <n>         Stop after n detail requests
  --rate <n>          Requests per second (default from config: portal.requestsPerSecond)
  --concurrency <n>   Parallel requests (default from config: portal.concurrency)
  -h, --help          Show this help
`;

const { values } = parseArgs({
  options: {
    'game-version': { type: 'string' },
    all: { type: 'boolean', default: false },
    'stale-days': { type: 'string' },
    resume: { type: 'boolean', default: false },
    limit: { type: 'string' },
    rate: { type: 'string' },
    concurrency: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const nonNegative = (flag: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Invalid value for --${flag}: ${raw}`);
    process.exit(1);
  }
  return n;
};

const config = loadConfig();
const gameVersion = values['game-version'] ?? config.sync.gameVersion;
if (!/^(latest|\d+\.\d+)$/.test(gameVersion)) {
  console.error(`Invalid --game-version "${gameVersion}". Use "latest" or e.g. "2.0".`);
  process.exit(1);
}
const portal = {
  ...config.portal,
  requestsPerSecond: nonNegative('rate', values.rate) || config.portal.requestsPerSecond,
};
const concurrency = nonNegative('concurrency', values.concurrency) || portal.concurrency;

const db = openDatabase(config.dbPath);
const client = new PortalClient(portal);
const controller = new AbortController();

process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(130);
  process.stdout.write('\nStopping after in-flight requests… (Ctrl+C again to force)\n');
  controller.abort();
});

const isTTY = process.stdout.isTTY;
let lastLine = 0;
let started = Date.now();

function render(p: SyncProgress): void {
  if (p.phase === 'details' && p.queued > 0) {
    if (p.done === 0) started = Date.now();
    const now = Date.now();
    if (!isTTY && now - lastLine < 5000 && p.done < p.queued) return;
    lastLine = now;
    const pct = ((p.done / p.queued) * 100).toFixed(1);
    const rate = p.done / Math.max(1, (now - started) / 1000);
    const eta = rate > 0 ? Math.round((p.queued - p.done) / rate) : 0;
    const line = `  details ${p.done}/${p.queued} (${pct}%)  failed ${p.failed}  ~${formatDuration(eta)} left  ${p.current ?? ''}`;
    if (isTTY)
      process.stdout.write(
        `\r${line.slice(0, process.stdout.columns - 1).padEnd(process.stdout.columns - 1)}`,
      );
    else console.log(line);
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

console.log(`Database: ${config.dbPath}`);
console.log(`Throttle: ${portal.requestsPerSecond} req/s, concurrency ${concurrency}`);
if (!values.resume) console.log('Downloading mod list…');

try {
  let announced = false;
  const result = await runSync(db, client, {
    gameVersion,
    all: values.all,
    staleDays: nonNegative('stale-days', values['stale-days']) ?? config.sync.staleDays,
    resumeOnly: values.resume,
    limit: nonNegative('limit', values.limit),
    concurrency,
    signal: controller.signal,
    onProgress: (p) => {
      if (p.phase === 'details' && !announced) {
        announced = true;
        if (!values.resume) {
          console.log(
            `Mod list: ${p.listed} mods (${p.added} new, ${p.changed} updated, ${p.removed} removed)`,
          );
        }
        console.log(
          values.all
            ? 'Scope: all game versions'
            : `Scope: Factorio ${p.gameVersion ?? '?'} and newer`,
        );
        console.log(p.message);
      }
      render(p);
    },
  });
  if (isTTY && result.queued > 0) process.stdout.write('\n');
  console.log(`${result.message} (${result.done} fetched, ${result.failed} failed)`);
  process.exitCode = result.phase === 'aborted' ? 130 : 0;
} catch (err) {
  if (isTTY) process.stdout.write('\n');
  if (err instanceof SyncLockedError) {
    console.error(`${err.message} If it crashed, wait ten minutes and retry.`);
  } else {
    console.error('Sync failed:', err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
} finally {
  db.close();
}
