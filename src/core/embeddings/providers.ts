import type { Config } from '../config.js';

/** Turns texts into vectors. Implementations must return one vector per input, in order. */
export interface EmbeddingProvider {
  /** Stable identifier of provider + model; changing it rebuilds the index. */
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbeddingConfig = Config['embeddings'];

export const DEFAULT_EMBEDDING_MODELS = {
  transformers: 'Xenova/all-MiniLM-L6-v2',
  ollama: 'nomic-embed-text',
  openai: 'text-embedding-3-small',
} as const;

const DEFAULT_BASE_URLS = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
} as const;

/** Some models are trained with task prefixes and perform much worse without them. */
export function defaultPrefixes(model: string): { query: string; document: string } {
  const m = model.toLowerCase();
  if (m.includes('nomic-embed')) return { query: 'search_query: ', document: 'search_document: ' };
  if (/(^|[/-])e5-/.test(m)) return { query: 'query: ', document: 'passage: ' };
  return { query: '', document: '' };
}

const TRANSFORMERS_MICRO_BATCH = 8;

/** Local, in-process embeddings via transformers.js (ONNX on CPU). Downloads the model once. */
export class TransformersProvider implements EmbeddingProvider {
  readonly id: string;
  private extractor: Promise<
    (texts: string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>
  > | null = null;

  constructor(
    private readonly model: string,
    private readonly cacheDir: string,
  ) {
    this.id = `transformers:${model}`;
  }

  private load() {
    this.extractor ??= (async () => {
      // Imported lazily: loading ONNX runtime is slow and unnecessary when theme search is unused.
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.cacheDir;
      const pipe = await pipeline('feature-extraction', this.model, { dtype: 'q8' });
      return pipe as unknown as (
        texts: string[],
        opts: object,
      ) => Promise<{ data: Float32Array; dims: number[] }>;
    })().catch((err: unknown) => {
      this.extractor = null;
      throw err;
    });
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extract = await this.load();
    const vectors: Float32Array[] = [];
    // Small micro-batches are fastest on CPU: every text is padded to the longest in its batch.
    for (let i = 0; i < texts.length; i += TRANSFORMERS_MICRO_BATCH) {
      const chunk = texts.slice(i, i + TRANSFORMERS_MICRO_BATCH);
      const out = await extract(chunk, { pooling: 'mean', normalize: true });
      const dims = out.dims.at(-1)!;
      chunk.forEach((_, j) => vectors.push(out.data.slice(j * dims, (j + 1) * dims)));
    }
    return vectors;
  }
}

async function postJson<T>(url: string, body: unknown, apiKey?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Embeddings request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Ollama's /api/embed endpoint (e.g. `ollama pull nomic-embed-text`). */
export class OllamaProvider implements EmbeddingProvider {
  readonly id: string;
  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
  ) {
    this.id = `ollama:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const res = await postJson<{ embeddings: number[][] }>(
      `${this.baseUrl.replace(/\/$/, '')}/api/embed`,
      {
        model: this.model,
        input: texts,
      },
    );
    return res.embeddings.map((v) => Float32Array.from(v));
  }
}

/** Any OpenAI-compatible /embeddings endpoint: OpenAI, LM Studio, llama.cpp server, vLLM… */
export class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly id: string;
  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {
    this.id = `openai:${model}@${baseUrl}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const res = await postJson<{ data: { index: number; embedding: number[] }[] }>(
      `${this.baseUrl.replace(/\/$/, '')}/embeddings`,
      { model: this.model, input: texts },
      this.apiKey,
    );
    return [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding));
  }
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | null {
  switch (config.provider) {
    case 'none':
      return null;
    case 'transformers':
      return new TransformersProvider(
        config.model ?? DEFAULT_EMBEDDING_MODELS.transformers,
        config.cacheDir,
      );
    case 'ollama':
      return new OllamaProvider(
        config.model ?? DEFAULT_EMBEDDING_MODELS.ollama,
        config.baseUrl ?? DEFAULT_BASE_URLS.ollama,
      );
    case 'openai':
      return new OpenAICompatibleProvider(
        config.model ?? DEFAULT_EMBEDDING_MODELS.openai,
        config.baseUrl ?? DEFAULT_BASE_URLS.openai,
        config.apiKey,
      );
  }
}

/** Resolves the effective prefixes and model name for a config. */
export function embeddingPrefixes(config: EmbeddingConfig): { query: string; document: string } {
  const model =
    config.model ?? (config.provider === 'none' ? '' : DEFAULT_EMBEDDING_MODELS[config.provider]);
  const defaults = defaultPrefixes(model);
  return {
    query: config.queryPrefix ?? defaults.query,
    document: config.documentPrefix ?? defaults.document,
  };
}
