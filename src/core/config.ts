import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
      /** Update theme-search embeddings after each sync. */
      embed: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Embeddings for semantic "theme" search. Independent from any chat LLM
   * (Claude, for example, has no embeddings API).
   */
  embeddings: z
    .object({
      /** transformers = local, in-process (default); ollama / openai = HTTP APIs; none = disabled. */
      provider: z.enum(['transformers', 'ollama', 'openai', 'none']).default('transformers'),
      /** Model name. Defaults depend on the provider (see DEFAULT_EMBEDDING_MODELS). */
      model: z.string().min(1).optional(),
      /** API base URL for ollama / openai-compatible providers (LM Studio, llama.cpp, OpenAI…). */
      baseUrl: z.string().url().optional(),
      /** API key for openai-compatible providers. Prefer the FMF_EMBEDDINGS_API_KEY env var. */
      apiKey: z.string().optional(),
      /** Text prepended to queries / documents. Defaults are known for nomic and e5 models. */
      queryPrefix: z.string().optional(),
      documentPrefix: z.string().optional(),
      batchSize: z.coerce.number().int().min(1).max(512).default(64),
      /** Where transformers.js caches downloaded models. */
      cacheDir: z.string().default('data/models'),
      /** Nearest neighbours considered per theme search before filters are applied. */
      candidates: z.coerce.number().int().min(10).max(4096).default(400),
    })
    .prefault({}),
  /**
   * Chat LLM for natural-language search. It only turns requests into filter objects
   * (and explains results on demand); it never reads the database.
   */
  llm: z
    .object({
      /** openai = any OpenAI-compatible API (Ollama, LM Studio, llama.cpp, OpenRouter, OpenAI). */
      provider: z.enum(['none', 'openai', 'anthropic']).default('none'),
      baseUrl: z.string().url().optional(),
      model: z.string().min(1).optional(),
      apiKey: z.string().optional(),
      timeoutMs: z.coerce.number().int().positive().default(60_000),
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
    embeddings: pick({
      provider: env.FMF_EMBEDDINGS_PROVIDER,
      model: env.FMF_EMBEDDINGS_MODEL,
      baseUrl: env.FMF_EMBEDDINGS_BASE_URL,
      apiKey: env.FMF_EMBEDDINGS_API_KEY,
    }),
    llm: pick({
      provider: env.FMF_LLM_PROVIDER,
      baseUrl: env.FMF_LLM_BASE_URL,
      model: env.FMF_LLM_MODEL,
      apiKey: env.FMF_LLM_API_KEY,
    }),
  };
}

/** Settings that the UI can edit, and the env vars that override them. */
export const EDITABLE_SETTINGS = {
  llm: {
    provider: 'FMF_LLM_PROVIDER',
    baseUrl: 'FMF_LLM_BASE_URL',
    model: 'FMF_LLM_MODEL',
    apiKey: 'FMF_LLM_API_KEY',
  },
  embeddings: {
    provider: 'FMF_EMBEDDINGS_PROVIDER',
    baseUrl: 'FMF_EMBEDDINGS_BASE_URL',
    model: 'FMF_EMBEDDINGS_MODEL',
    apiKey: 'FMF_EMBEDDINGS_API_KEY',
  },
} as const;

export type EditableSection = keyof typeof EDITABLE_SETTINGS;
export type EditableField = 'provider' | 'baseUrl' | 'model' | 'apiKey';

/** Fields of a section that are fixed by environment variables (the UI cannot change them). */
export function envOverrides(section: EditableSection, env = process.env): EditableField[] {
  return (Object.entries(EDITABLE_SETTINGS[section]) as [EditableField, string][])
    .filter(([, name]) => env[name] !== undefined && env[name] !== '')
    .map(([field]) => field);
}

/**
 * Applies a patch to config.json, keeping every other key. `null` removes a field.
 * The file can contain API keys, so it is written atomically and readable only by the owner.
 */
export function saveConfigPatch(
  cwd: string,
  patch: Partial<Record<EditableSection, Partial<Record<EditableField, string | null>>>>,
): void {
  const path = resolve(cwd, 'config.json');
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>)
    : {};
  for (const [section, fields] of Object.entries(patch)) {
    if (!fields || !Object.keys(fields).length) continue;
    const target = { ...(current[section] ?? {}) };
    for (const [field, value] of Object.entries(fields ?? {})) {
      if (value === null) delete target[field];
      else if (value !== undefined) target[field] = value;
    }
    current[section] = target;
  }
  // Validate before writing so a bad value never ends up on disk.
  ConfigSchema.parse(current);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported on this platform */
  }
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
  return {
    ...config,
    dbPath: resolve(cwd, config.dbPath),
    embeddings: { ...config.embeddings, cacheDir: resolve(cwd, config.embeddings.cacheDir) },
  };
}
