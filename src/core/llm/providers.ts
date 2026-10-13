import type { Config } from '../config.js';

export type LlmConfig = Config['llm'];

export interface StructuredRequest {
  system: string;
  user: string;
  /** JSON Schema of the expected object. */
  schema: Record<string, unknown>;
  /** Short identifier for the schema / tool, e.g. "search_filter". */
  name: string;
  description: string;
}

/** A chat model that returns a JSON object for a prompt. */
export interface ChatProvider {
  readonly id: string;
  /** Returns the parsed (not yet validated) JSON object produced by the model. */
  structured(req: StructuredRequest): Promise<unknown>;
  listModels(): Promise<string[]>;
}

export class LlmError extends Error {}

export const LLM_DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: undefined },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
} as const;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

async function request<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'timed out'
        : String(err instanceof Error ? (err.cause ?? err.message) : err);
    throw new LlmError(`Could not reach ${new URL(url).origin}: ${reason}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail =
        (typeof body.error === 'string' ? body.error : body.error?.message) ??
        body.message ??
        detail;
    } catch {
      /* not JSON */
    }
    throw new LlmError(`HTTP ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError('The API returned invalid JSON.');
  }
}

/**
 * Extracts a JSON object from model text output: plain JSON, a ```json fenced block,
 * or the first {...} span. Small local models often wrap JSON in prose.
 */
export function extractJson(text: string): unknown {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new LlmError('The model did not return valid JSON.');
}

type ResponseFormatMode = 'json_schema' | 'json_object' | 'none';

/** OpenAI-compatible /chat/completions: Ollama, LM Studio, llama.cpp, OpenRouter, OpenAI… */
export class OpenAICompatibleChat implements ChatProvider {
  readonly id: string;
  /** Remembers the strongest structured-output mode the server accepted. */
  private mode: ResponseFormatMode = 'json_schema';

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
  ) {
    this.id = `openai:${model}@${baseUrl}`;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      // Identifies the app on OpenRouter; ignored elsewhere.
      'X-Title': 'Factorio Mod Finder',
    };
  }

  async structured(req: StructuredRequest): Promise<unknown> {
    const modes: ResponseFormatMode[] = ['json_schema', 'json_object', 'none'];
    for (const mode of modes.slice(modes.indexOf(this.mode))) {
      const responseFormat =
        mode === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: { name: req.name, schema: req.schema, strict: false },
            }
          : mode === 'json_object'
            ? { type: 'json_object' }
            : undefined;
      const system =
        mode === 'json_schema'
          ? req.system
          : `${req.system}\n\nRespond with a single JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(req.schema)}`;
      try {
        const res = await request<{ choices?: { message?: { content?: string | null } }[] }>(
          `${trimSlash(this.baseUrl)}/chat/completions`,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
              model: this.model,
              temperature: 0,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: req.user },
              ],
              ...(responseFormat ? { response_format: responseFormat } : {}),
            }),
          },
          this.timeoutMs,
        );
        this.mode = mode;
        const content = res.choices?.[0]?.message?.content;
        if (!content) throw new LlmError('The model returned an empty answer.');
        return extractJson(content);
      } catch (err) {
        // Servers without structured-output support reject response_format with a 400/422.
        const unsupported = err instanceof LlmError && /^HTTP (400|422)/.test(err.message);
        if (!unsupported || mode === 'none') throw err;
      }
    }
    throw new LlmError('Unreachable');
  }

  async listModels(): Promise<string[]> {
    const res = await request<{ data?: { id: string }[] }>(
      `${trimSlash(this.baseUrl)}/models`,
      { headers: this.headers() },
      15_000,
    );
    return (res.data ?? []).map((m) => m.id).sort();
  }
}

/** Anthropic Messages API. Structured output is obtained by forcing a single tool call. */
export class AnthropicChat implements ChatProvider {
  readonly id: string;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
  ) {
    this.id = `anthropic:${model}`;
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new LlmError('An API key is required for Anthropic.');
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  async structured(req: StructuredRequest): Promise<unknown> {
    const res = await request<{
      content?: { type: string; name?: string; input?: unknown }[];
      stop_reason?: string;
    }>(
      `${trimSlash(this.baseUrl)}/v1/messages`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          tools: [{ name: req.name, description: req.description, input_schema: req.schema }],
          tool_choice: { type: 'tool', name: req.name },
        }),
      },
      this.timeoutMs,
    );
    const call = res.content?.find((b) => b.type === 'tool_use' && b.name === req.name);
    if (!call)
      throw new LlmError(
        `The model did not return a result (stop reason: ${res.stop_reason ?? 'unknown'}).`,
      );
    return call.input;
  }

  async listModels(): Promise<string[]> {
    const res = await request<{ data?: { id: string }[] }>(
      `${trimSlash(this.baseUrl)}/v1/models?limit=100`,
      { headers: this.headers() },
      15_000,
    );
    return (res.data ?? []).map((m) => m.id);
  }
}

/** Builds the configured provider, or explains why it cannot. */
export function createChatProvider(config: LlmConfig): ChatProvider | { error: string } {
  if (config.provider === 'none')
    return { error: 'No AI provider is configured. Set one up in Settings.' };
  const defaults = LLM_DEFAULTS[config.provider];
  const baseUrl = config.baseUrl ?? defaults.baseUrl;
  const model = config.model ?? defaults.model;
  if (!model) return { error: 'Choose a model for the AI provider in Settings.' };
  return config.provider === 'anthropic'
    ? new AnthropicChat(baseUrl, model, config.apiKey, config.timeoutMs)
    : new OpenAICompatibleChat(baseUrl, model, config.apiKey, config.timeoutMs);
}

/** Like createChatProvider but for listing models, where no model is needed yet. */
export function createModelLister(config: LlmConfig): ChatProvider | { error: string } {
  if (config.provider === 'none') return { error: 'Choose a provider first.' };
  return createChatProvider({ ...config, model: config.model ?? 'unused' });
}
