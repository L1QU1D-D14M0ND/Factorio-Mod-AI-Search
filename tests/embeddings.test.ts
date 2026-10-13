import { describe, expect, it } from 'vitest';
import { applyModList } from '../src/core/sync/apply.js';
import {
  embeddingText,
  indexStatus,
  updateEmbeddings,
  vectorBlob,
} from '../src/core/embeddings/index.js';
import { defaultPrefixes, type EmbeddingProvider } from '../src/core/embeddings/providers.js';
import { buildModQuery } from '../src/core/query.js';
import { ModFilterSchema } from '../src/shared/filters.js';
import { listEntry, NOW, seedDb } from './helpers.js';

const TOPICS = ['train', 'biter', 'planet'];

/** Deterministic fake model: one dimension per topic keyword found in the text. */
class FakeProvider implements EmbeddingProvider {
  calls: string[][] = [];
  constructor(readonly id = 'fake:topics') {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = Float32Array.from(TOPICS.map((k) => (t.toLowerCase().includes(k) ? 1 : 0.01)));
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  }
}

const embeddedTexts = (p: FakeProvider) => p.calls.slice(1).flat(); // first call is the probe

function catalogue() {
  return seedDb([
    {
      entry: listEntry('rails', {
        title: 'Rail World',
        summary: 'Better train stations',
        downloads_count: 500,
      }),
    },
    {
      entry: listEntry('loco', {
        title: 'Locomotives+',
        summary: 'Faster train engines',
        downloads_count: 50,
        category: 'tweaks',
      }),
    },
    {
      entry: listEntry('nest', {
        title: 'Nests',
        summary: 'Angrier biter colonies',
        downloads_count: 900,
      }),
    },
    {
      entry: listEntry('aqua', {
        title: 'Aquatic',
        summary: 'An ocean planet',
        downloads_count: 10,
      }),
    },
  ]);
}

describe('embeddingText', () => {
  it('joins title and summary and collapses whitespace', () => {
    expect(embeddingText(' Foo ', 'Line one\r\n  line two ')).toBe('Foo. Line one line two');
    expect(embeddingText('Foo', '')).toBe('Foo');
  });
});

describe('defaultPrefixes', () => {
  it('knows task prefixes for nomic and e5 models', () => {
    expect(defaultPrefixes('nomic-embed-text').query).toBe('search_query: ');
    expect(defaultPrefixes('intfloat/multilingual-e5-small').document).toBe('passage: ');
    expect(defaultPrefixes('Xenova/all-MiniLM-L6-v2')).toEqual({ query: '', document: '' });
  });
});

describe('updateEmbeddings', () => {
  it('embeds incrementally and only re-embeds changed text', async () => {
    const db = catalogue();
    const first = new FakeProvider();
    const r1 = await updateEmbeddings(db, first, { documentPrefix: 'doc: ' });
    expect(r1).toMatchObject({ total: 4, done: 4, rebuilt: true });
    expect(embeddedTexts(first)).toContain('doc: Nests. Angrier biter colonies');
    expect(indexStatus(db)).toMatchObject({ model: 'fake:topics', dimensions: 3, indexed: 4 });

    const second = new FakeProvider();
    expect(await updateEmbeddings(db, second)).toMatchObject({ total: 0, rebuilt: false });

    // Summary change on one mod -> only that mod is embedded again.
    applyModList(
      db,
      ['rails', 'loco', 'nest', 'aqua'].map((n) =>
        n === 'aqua'
          ? listEntry('aqua', {
              title: 'Aquatic',
              summary: 'Ocean planet with trains',
              downloads_count: 10,
            })
          : (db
              .prepare('SELECT name, title, summary, downloads_count FROM mods WHERE name = ?')
              .get(n) as never),
      ),
      NOW,
    );
    const third = new FakeProvider();
    await updateEmbeddings(db, third);
    expect(embeddedTexts(third)).toEqual(['Aquatic. Ocean planet with trains']);
  });

  it('rebuilds the index when the model changes', async () => {
    const db = catalogue();
    await updateEmbeddings(db, new FakeProvider('fake:a'));
    const other = new FakeProvider('fake:b');
    expect(await updateEmbeddings(db, other)).toMatchObject({ total: 4, rebuilt: true });
  });
});

describe('theme search query', () => {
  it('ranks by similarity and combines with regular filters', async () => {
    const db = catalogue();
    const provider = new FakeProvider();
    await updateEmbeddings(db, provider);
    const [query] = await provider.embed(['trains please']);
    const semantic = { vector: vectorBlob(query!), k: 10 };

    const run = (input: object) => {
      const q = buildModQuery(
        ModFilterSchema.parse({ semantic: 'trains please', ...input }),
        semantic,
      );
      return db.prepare(q.sql).all(...q.params) as { name: string; similarity: number }[];
    };

    const all = run({});
    expect(all.slice(0, 2).map((r) => r.name)).toEqual(['rails', 'loco']);
    expect(all[0]!.similarity).toBeGreaterThan(0.9);
    expect(all.at(-1)!.similarity).toBeLessThan(0.1);

    expect(run({ categories: ['tweaks'] }).map((r) => r.name)).toEqual(['loco']);
    expect(run({ q: 'faster' }).map((r) => r.name)).toEqual(['loco']);
  });

  it('ignores the theme when no vector is provided', () => {
    const q = buildModQuery(ModFilterSchema.parse({ semantic: 'trains' }));
    expect(q.sql).not.toContain('vec_mods');
    expect(q.sql).toContain('NULL AS similarity');
  });
});
