import type { DB } from '../db/connection.js';
import { vectorSupportError } from '../db/connection.js';
import {
  indexMatches,
  indexStatus,
  updateEmbeddings,
  vectorBlob,
  type EmbedProgress,
} from './index.js';
import {
  createEmbeddingProvider,
  embeddingPrefixes,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from './providers.js';

export interface ThemeSearchStatus {
  enabled: boolean;
  provider: string | null;
  /** The index exists, matches the configured provider, and has vectors. */
  ready: boolean;
  indexed: number;
  mods: number;
  /** Why theme search is not available, if it is not. */
  reason: string | null;
}

/** Theme search: owns the embedding provider and turns queries into vectors. */
export class ThemeSearch {
  readonly provider: EmbeddingProvider | null;
  private readonly prefixes: { query: string; document: string };
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly db: DB,
    private readonly config: EmbeddingConfig,
  ) {
    this.provider = createEmbeddingProvider(config);
    this.prefixes = embeddingPrefixes(config);
  }

  status(): ThemeSearchStatus {
    const index = indexStatus(this.db);
    const base = { provider: this.provider?.id ?? null, indexed: index.indexed, mods: index.mods };
    if (!this.provider) {
      return {
        ...base,
        enabled: false,
        ready: false,
        reason: 'Theme search is disabled in the configuration.',
      };
    }
    const vecError = vectorSupportError(this.db);
    if (vecError)
      return {
        ...base,
        enabled: true,
        ready: false,
        reason: `sqlite-vec failed to load: ${vecError}`,
      };
    if (!indexMatches(this.db, this.provider.id) || index.indexed === 0) {
      return {
        ...base,
        indexed: 0,
        enabled: true,
        ready: false,
        reason: 'The theme index has not been built yet. Run "npm run embed" or press Refresh.',
      };
    }
    return { ...base, enabled: true, ready: true, reason: null };
  }

  /** Embeds a theme query. Throws with a user-facing message when unavailable. */
  async queryVector(text: string): Promise<Buffer> {
    const status = this.status();
    if (!status.ready || !this.provider)
      throw new Error(status.reason ?? 'Theme search unavailable.');
    const key = text.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const [vector] = await this.provider.embed([this.prefixes.query + text]);
    if (!vector) throw new Error('The embedding provider returned no vector.');
    const blob = vectorBlob(vector);
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, blob);
    return blob;
  }

  /** Embeds new or changed mods. No-op when disabled. */
  async update(
    opts: { rebuild?: boolean; signal?: AbortSignal; onProgress?: (p: EmbedProgress) => void } = {},
  ): Promise<EmbedProgress | null> {
    if (!this.provider) return null;
    const result = await updateEmbeddings(this.db, this.provider, {
      ...opts,
      documentPrefix: this.prefixes.document,
      batchSize: this.config.batchSize,
    });
    return result;
  }
}
