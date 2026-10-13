import { z } from 'zod';
import {
  envOverrides,
  saveConfigPatch,
  type Config,
  type EditableField,
  type EditableSection,
} from '../core/config.js';
import {
  embeddingPrefixes,
  createEmbeddingProvider,
  DEFAULT_EMBEDDING_MODELS,
} from '../core/embeddings/providers.js';
import {
  createChatProvider,
  createModelLister,
  LLM_DEFAULTS,
  LlmError,
} from '../core/llm/providers.js';
import type { SectionSettings, SettingsResponse } from '../shared/types.js';
import type { Services } from './services.js';

const nullableString = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));

const SectionPatch = z.object({
  provider: z.string().optional(),
  baseUrl: nullableString.refine(
    (v) => v == null || /^https?:\/\/\S+$/i.test(v),
    'Must be an http(s) URL',
  ),
  model: nullableString,
  apiKey: nullableString,
});

export const SettingsPatchSchema = z.object({
  llm: SectionPatch.extend({
    provider: z.enum(['none', 'openai', 'anthropic']).optional(),
  }).optional(),
  embeddings: SectionPatch.extend({
    provider: z.enum(['transformers', 'ollama', 'openai', 'none']).optional(),
  }).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const DraftSchema = z.object({
  section: z.enum(['llm', 'embeddings']),
  draft: SectionPatch.extend({ provider: z.string() }),
});

function section(config: Config, name: EditableSection, env: NodeJS.ProcessEnv): SectionSettings {
  const s = config[name];
  return {
    provider: s.provider,
    baseUrl: s.baseUrl ?? null,
    model: s.model ?? null,
    // The key itself never leaves the server.
    apiKeySet: !!s.apiKey,
    locked: envOverrides(name, env),
  };
}

export function publicSettings(services: Services): SettingsResponse {
  const { config, env, theme, llm } = services;
  return {
    llm: section(config, 'llm', env),
    embeddings: section(config, 'embeddings', env),
    status: {
      llm: 'error' in llm ? { ready: false, message: llm.error } : { ready: true, message: llm.id },
      theme: theme.status(),
    },
    defaults: {
      llm: {
        openai: { baseUrl: LLM_DEFAULTS.openai.baseUrl, model: null },
        anthropic: { baseUrl: LLM_DEFAULTS.anthropic.baseUrl, model: LLM_DEFAULTS.anthropic.model },
      },
      embeddings: {
        transformers: { baseUrl: null, model: DEFAULT_EMBEDDING_MODELS.transformers },
        ollama: { baseUrl: 'http://127.0.0.1:11434', model: DEFAULT_EMBEDDING_MODELS.ollama },
        openai: { baseUrl: 'https://api.openai.com/v1', model: DEFAULT_EMBEDDING_MODELS.openai },
      },
    },
  };
}

export class SettingsError extends Error {}

/** Saves a settings patch to config.json and reloads the services. */
export function applySettings(services: Services, patch: SettingsPatch): void {
  const out: Partial<Record<EditableSection, Partial<Record<EditableField, string | null>>>> = {};
  for (const name of ['llm', 'embeddings'] as const) {
    const fields = patch[name];
    if (!fields) continue;
    const locked = new Set(envOverrides(name, services.env));
    const changes: Partial<Record<EditableField, string | null>> = {};
    for (const [field, value] of Object.entries(fields) as [
      EditableField,
      string | null | undefined,
    ][]) {
      if (value === undefined) continue;
      if (locked.has(field)) {
        throw new SettingsError(
          `${name}.${field} is set by an environment variable and cannot be changed here.`,
        );
      }
      changes[field] = value;
    }
    out[name] = changes;
  }
  saveConfigPatch(services.cwd, out);
  services.reload();
}

/** Effective section config for a draft: unsent API keys fall back to the saved one. */
function draftConfig<S extends EditableSection>(
  services: Services,
  name: S,
  draft: z.infer<typeof DraftSchema>['draft'],
) {
  const saved = services.config[name];
  return {
    ...saved,
    provider: draft.provider,
    baseUrl: draft.baseUrl ?? undefined,
    model: draft.model ?? undefined,
    apiKey: draft.apiKey === undefined ? saved.apiKey : (draft.apiKey ?? undefined),
  } as Config[S];
}

/** Runs a tiny real request with draft settings (before saving them). */
export async function testSettings(
  services: Services,
  input: z.infer<typeof DraftSchema>,
): Promise<string> {
  if (input.section === 'llm') {
    const config = draftConfig(services, 'llm', input.draft);
    const llm = createChatProvider(config);
    if ('error' in llm) throw new SettingsError(llm.error);
    const started = Date.now();
    const raw = await llm.structured({
      name: 'connection_test',
      description: 'Connection test.',
      system: 'You are a connection test. Answer with ok set to true.',
      user: 'Is this working?',
      schema: z.toJSONSchema(z.object({ ok: z.boolean() })) as Record<string, unknown>,
    });
    const ok = z.object({ ok: z.boolean() }).safeParse(raw);
    if (!ok.success)
      throw new LlmError('Connected, but the model did not return the expected JSON.');
    return `Connected to ${llm.id} (${Date.now() - started} ms).`;
  }
  const config = draftConfig(services, 'embeddings', input.draft);
  const provider = createEmbeddingProvider(config);
  if (!provider) throw new SettingsError('Theme search is disabled.');
  const started = Date.now();
  const [vector] = await provider.embed([`${embeddingPrefixes(config).query}factorio trains`]);
  if (!vector?.length) throw new SettingsError('The provider returned an empty vector.');
  return `Working: ${provider.id} returns ${vector.length}-dimensional vectors (${Date.now() - started} ms).`;
}

/** Lists the models a provider offers, for the model picker. */
export async function listModels(
  services: Services,
  input: z.infer<typeof DraftSchema>,
): Promise<string[]> {
  if (input.section === 'llm') {
    const lister = createModelLister(draftConfig(services, 'llm', input.draft));
    if ('error' in lister) throw new SettingsError(lister.error);
    return lister.listModels();
  }
  const config = draftConfig(services, 'embeddings', input.draft);
  if (config.provider === 'transformers' || config.provider === 'none') return [];
  const base = (
    config.baseUrl ??
    (config.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '');
  const url = config.provider === 'ollama' ? `${base}/api/tags` : `${base}/models`;
  const res = await fetch(url, {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  }).catch((err: unknown) => {
    throw new SettingsError(
      `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (!res.ok) throw new SettingsError(`HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { models?: { name: string }[]; data?: { id: string }[] };
  return (body.models?.map((m) => m.name) ?? body.data?.map((m) => m.id) ?? []).sort();
}
