import { describe, expect, it } from 'vitest';
import { updateEmbeddings } from '../src/core/embeddings/index.js';
import type { EmbeddingProvider } from '../src/core/embeddings/providers.js';
import { buildModQuery } from '../src/core/query.js';
import { findSimilar } from '../src/core/related.js';
import { ModFilterSchema } from '../src/shared/filters.js';
import { fullMod, listEntry, seedDb } from './helpers.js';

function catalogue() {
  const mods = [
    {
      name: 'trains-a',
      summary: 'Train logistics',
      tags: ['trains', 'logistics'],
      deps: ['base', 'rail-lib', 'flib'],
    },
    {
      name: 'trains-b',
      summary: 'Train stops',
      tags: ['trains', 'logistics'],
      deps: ['base', 'rail-lib'],
    },
    { name: 'trains-c', summary: 'Train colours', tags: ['trains'], deps: ['base', 'flib'] },
    { name: 'biters', summary: 'Angry biters', tags: ['enemies'], deps: ['base', 'flib'] },
    { name: 'rail-lib', summary: 'A library', tags: [], deps: ['base'] },
    { name: 'flib', summary: 'Common library', tags: [], deps: ['base'] },
    // Many mods use flib, so sharing it is a weak signal.
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `user${i}`,
      summary: 'Misc',
      tags: [],
      deps: ['flib'],
    })),
  ];
  return seedDb(
    mods.map((m) => {
      const entry = listEntry(m.name, { title: m.name, summary: m.summary });
      return { entry, full: fullMod(entry, { tags: m.tags, dependencies: m.deps }) };
    }),
  );
}

describe('findSimilar', () => {
  it('combines shared tags and rarity-weighted shared dependencies', () => {
    const db = catalogue();
    const result = findSimilar(db, 'trains-a');
    expect(result.signals).toEqual({ theme: false, tags: true, dependencies: true });
    const ids = new Map(
      (db.prepare('SELECT id, name FROM mods').all() as { id: number; name: string }[]).map((r) => [
        r.id,
        r.name,
      ]),
    );
    const names = result.candidates.map((c) => ids.get(c.id));
    // Same tags + same niche library beats sharing only the ubiquitous one.
    expect(names[0]).toBe('trains-b');
    expect(names.indexOf('trains-c')).toBeLessThan(names.indexOf('biters'));
    // Never the mod itself or the libraries it requires.
    expect(names).not.toContain('trains-a');
    expect(names).not.toContain('rail-lib');
    expect(names).not.toContain('flib');
    for (const c of result.candidates) expect(c.score).toBeGreaterThan(0);
  });

  it('uses the theme index when available', async () => {
    const db = catalogue();
    const provider: EmbeddingProvider = {
      id: 'fake',
      embed: async (texts) =>
        texts.map((t) => Float32Array.from(t.toLowerCase().includes('biter') ? [0, 1] : [1, 0.05])),
    };
    await updateEmbeddings(db, provider);
    const result = findSimilar(db, 'biters');
    expect(result.signals.theme).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('reports unknown mods', () => {
    expect(findSimilar(catalogue(), 'nope').target).toBeNull();
  });

  it('feeds a ranked search that still applies other filters', () => {
    const db = catalogue();
    const { candidates } = findSimilar(db, 'trains-a');
    const run = (input: object) => {
      const q = buildModQuery(
        ModFilterSchema.parse({ similarTo: 'trains-a', ...input }),
        undefined,
        { candidates },
      );
      return db.prepare(q.sql).all(...q.params) as { name: string; similarity: number }[];
    };
    const all = run({});
    expect(all[0]).toMatchObject({ name: 'trains-b' });
    expect(all[0]!.similarity).toBeGreaterThan(0);
    expect(run({ tags: ['enemies'] }).map((r) => r.name)).toEqual(['biters']);
  });
});
