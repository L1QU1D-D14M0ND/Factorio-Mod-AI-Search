import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const APP_VERSION = pkg.version;
const DEFAULT_USER_AGENT = `factorio-mod-finder/${APP_VERSION} (+https://github.com/L1QU1D-D14M0ND/Factorio-Mod-AI-Search)`;

const ConfigSchema = z.object({
  dbPath: z.string().default('data/mods.db'),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.coerce.number().int().min(1).max(65535).default(3000),
    })
    .prefault({}),
  portal: z
    .object({
      baseUrl: z.string().url().default('https://mods.factorio.com'),
      assetsUrl: z.string().url().default('https://assets-mod.factorio.com'),
      userAgent: z.string().min(1).default(DEFAULT_USER_AGENT),
      /** Max requests per second against /full endpoints. */
      requestsPerSecond: z.coerce.number().positive().max(10).default(3),
      /** Parallel in-flight /full requests (still bounded by requestsPerSecond). */
      concurrency: z.coerce.number().int().min(1).max(8).default(2),
      maxRetries: z.coerce.number().int().min(0).max(10).default(5),
      timeoutMs: z.coerce.number().int().positive().default(30_000),
    })
    .prefault({}),
  sync: z
    .object({
      /** Game version whose mods get full details: "latest" or a major version like "2.0". */
      gameVersion: z
        .string()
        .regex(/^(latest|\d+\.\d+)$/, 'must be "latest" or a version like "2.0"')
        .default('latest'),
      /** Re-fetch /full for mods whose details are older than this many days (0 = never). */
      staleDays: z.coerce.number().int().min(0).default(0),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function fromEnv(env: NodeJS.ProcessEnv): DeepPartial<Record<string, Record<string, unknown>>> {
  const pick = (entries: Record<string, string | undefined>) =>
    Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined && v !== ''));
  return {
    server: pick({ host: env.FMF_HOST, port: env.FMF_PORT }),
    portal: pick({
      requestsPerSecond: env.FMF_REQUESTS_PER_SECOND,
      concurrency: env.FMF_CONCURRENCY,
      userAgent: env.FMF_USER_AGENT,
    }),
    sync: pick({ gameVersion: env.FMF_GAME_VERSION }),
  };
}

function merge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prev &&
      typeof prev === 'object'
        ? merge(prev as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

/**
 * Loads config with precedence: defaults < config.json < .env / environment variables.
 */
export function loadConfig(cwd = process.cwd(), env = process.env): Config {
  const envFile = resolve(cwd, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const jsonPath = resolve(cwd, 'config.json');
  const fileConfig = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>)
    : {};

  let raw = merge(fileConfig, fromEnv(env));
  if (env.FMF_DB_PATH) raw = { ...raw, dbPath: env.FMF_DB_PATH };

  const config = ConfigSchema.parse(raw);
  return { ...config, dbPath: resolve(cwd, config.dbPath) };
}
