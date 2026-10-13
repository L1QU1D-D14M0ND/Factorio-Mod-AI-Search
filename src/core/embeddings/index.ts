import { createHash } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { deleteState, getState, setState, vectorSupportError } from '../db/connection.js';
import type { EmbeddingProvider } from './providers.js';

export interface EmbedProgress {
  total: number;
  done: number;
  rebuilt: boolean;
}

export interface IndexStatus {
  model: string | null;
  dimensions: number | null;
  indexed: number;
  mods: number;
}

/** The text that represents a mod for theme search: title + summary. */
export function embeddingText(title: string, summary: string): string {
  const t = title.trim();
  const s = summary.replace(/\s+/g, ' ').trim();
  return s ? `${t}. ${s}` : t;
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex');

/** Float32Array -> blob accepted by sqlite-vec. */
export const vectorBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

function vecTableExists(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_mods'").get();
}

/** (Re)creates the vector table when the provider or dimension changed. Returns true if rebuilt. */
function ensureVecTable(db: DB, providerId: string, dims: number): boolean {
  const current = getState(db, 'embedding_model');
  const currentDims = Number(getState(db, 'embedding_dims'));
  if (current === providerId && currentDims === dims && vecTableExists(db)) return false;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS vec_mods');
    db.exec(
      `CREATE VIRTUAL TABLE vec_mods USING vec0(embedding float[${dims}] distance_metric=cosine)`,
    );
    db.exec('DELETE FROM mod_embeddings');
    setState(db, 'embedding_model', providerId);
    setState(db, 'embedding_dims', String(dims));
  })();
  return true;
}

export function indexStatus(db: DB): IndexStatus {
  const model = getState(db, 'embedding_model');
  const dims = Number(getState(db, 'embedding_dims')) || null;
  const { indexed } = db.prepare('SELECT COUNT(*) AS indexed FROM mod_embeddings').get() as {
    indexed: number;
  };
  const { mods } = db
    .prepare('SELECT COUNT(*) AS mods FROM mods WHERE removed_at IS NULL')
    .get() as {
    mods: number;
  };
  return { model, dimensions: dims, indexed: model && vecTableExists(db) ? indexed : 0, mods };
}

/** True when the vector index exists and was built with this provider. */
export function indexMatches(db: DB, providerId: string): boolean {
  return getState(db, 'embedding_model') === providerId && vecTableExists(db);
}

export function dropIndex(db: DB): void {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS vec_mods');
    db.exec('DELETE FROM mod_embeddings');
    deleteState(db, 'embedding_model');
    deleteState(db, 'embedding_dims');
  })();
}

/**
 * Incrementally embeds every listed mod whose title/summary changed since it was last
 * embedded. Switching to a different model rebuilds the whole index.
 */
export async function updateEmbeddings(
  db: DB,
  provider: EmbeddingProvider,
  opts: {
    documentPrefix?: string;
    batchSize?: number;
    rebuild?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: EmbedProgress) => void;
  } = {},
): Promise<EmbedProgress> {
  const vecError = vectorSupportError(db);
  if (vecError) throw new Error(`Vector search unavailable (sqlite-vec): ${vecError}`);
  if (opts.rebuild) dropIndex(db);

  const [probe] = await provider.embed([`${opts.documentPrefix ?? ''}probe`]);
  if (!probe?.length) throw new Error('The embedding provider returned an empty vector.');
  const rebuilt = ensureVecTable(db, provider.id, probe.length);

  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.summary, e.text_hash FROM mods m
       LEFT JOIN mod_embeddings e ON e.mod_id = m.id
       WHERE m.removed_at IS NULL ORDER BY m.downloads_count DESC`,
    )
    .all() as { id: number; title: string; summary: string; text_hash: string | null }[];

  const todo = rows
    .map((r) => ({ id: r.id, text: embeddingText(r.title, r.summary), old: r.text_hash }))
    .map((r) => ({ ...r, hash: hash(r.text) }))
    .filter((r) => r.hash !== r.old)
    // Similar lengths per batch: the model pads every text to the longest one in its batch.
    .sort((a, b) => a.text.length - b.text.length);

  const progress: EmbedProgress = { total: todo.length, done: 0, rebuilt };
  opts.onProgress?.({ ...progress });

  const remove = db.prepare('DELETE FROM vec_mods WHERE rowid = ?');
  const insert = db.prepare('INSERT INTO vec_mods (rowid, embedding) VALUES (?, ?)');
  const mark = db.prepare(
    `INSERT INTO mod_embeddings (mod_id, text_hash, embedded_at) VALUES (?, ?, ?)
     ON CONFLICT(mod_id) DO UPDATE SET text_hash = excluded.text_hash, embedded_at = excluded.embedded_at`,
  );
  const batchSize = opts.batchSize ?? 64;

  for (let i = 0; i < todo.length && !opts.signal?.aborted; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const vectors = await provider.embed(batch.map((b) => (opts.documentPrefix ?? '') + b.text));
    if (vectors.length !== batch.length)
      throw new Error('Embedding provider returned a wrong number of vectors.');
    const now = new Date().toISOString();
    db.transaction(() => {
      batch.forEach((b, j) => {
        const vector = vectors[j]!;
        if (vector.length !== probe.length) throw new Error('Embedding dimension changed mid-run.');
        // sqlite-vec requires integer rowids; BigInt guarantees SQLite binds an INTEGER.
        remove.run(BigInt(b.id));
        insert.run(BigInt(b.id), vectorBlob(vector));
        mark.run(b.id, b.hash, now);
      });
    })();
    progress.done += batch.length;
    opts.onProgress?.({ ...progress });
  }
  return progress;
}
