import { beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/core/db/connection.js';
import { buildModQuery, toFtsQuery } from '../src/core/query.js';
import {
  filterFromSearchParams,
  filterToSearchParams,
  ModFilterSchema,
  type ModFilterInput,
} from '../src/shared/filters.js';
import { fullMod, listEntry, seedDb } from './helpers.js';

const filter = (input: ModFilterInput = {}) => ModFilterSchema.parse(input);

describe('toFtsQuery', () => {
  it('quotes words as prefix terms', () => {
    expect(toFtsQuery('Space rail mk2')).toBe('"space"* "rail"* "mk2"*');
  });

  it('neutralizes FTS syntax and quotes', () => {
    expect(toFtsQuery('foo" OR name:bar* NEAR(')).toBe('"foo"* "or"* "name"* "bar"* "near"*');
  });

  it('returns null for empty input', () => {
    expect(toFtsQuery('  -- !! ')).toBeNull();
  });
});

describe('buildModQuery (SQL shape)', () => {
  it('applies safe defaults', () => {
    const q = buildModQuery(filter());
    expect(q.sql).toContain('m.removed_at IS NULL');
    expect(q.sql).toContain('m.deprecated = 0');
    expect(q.sql).not.toContain('mods_fts');
    expect(q.sql).toMatch(/ORDER BY m\.downloads_count DESC/);
    expect(q.params).toEqual([30, 0]);
  });

  it('never interpolates user values', () => {
    const evil = "x'; DROP TABLE mods; --";
    const q = buildModQuery(filter({ q: evil, owner: evil, tags: [evil] }));
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toContain(evil);
  });

  it('orders params as they appear in the SQL', () => {
    const q = buildModQuery(
      filter({
        q: 'rail',
        categories: ['content', 'tweaks'],
        factorioVersion: '2.0',
        page: 3,
        pageSize: 10,
      }),
    );
    expect(q.params).toEqual([
      '"rail"*',
      'content',
      'tweaks',
      '2.0',
      '2.0',
      'rail',
      'rail',
      10,
      20,
    ]);
    expect(q.countParams).toEqual(['"rail"*', 'content', 'tweaks', '2.0', '2.0']);
    expect(q.sql.split('?').length - 1).toBe(q.params.length);
    expect(q.countSql.split('?').length - 1).toBe(q.countParams.length);
  });

  it('uses one EXISTS per tag in "all" mode and IN for "any"', () => {
    const all = buildModQuery(filter({ tags: ['trains', 'logistics'] }));
    expect(all.sql.match(/t\.tag = \?/g)).toHaveLength(2);
    const any = buildModQuery(filter({ tags: ['trains', 'logistics'], tagMode: 'any' }));
    expect(any.sql).toContain('t.tag IN (?, ?)');
  });
});

describe('buildModQuery (against SQLite)', () => {
  let db: DB;
  const run = (input: ModFilterInput = {}) => {
    const q = buildModQuery(filter(input));
    const rows = db.prepare(q.sql).all(...q.params) as { name: string }[];
    const { total } = db.prepare(q.countSql).get(...q.countParams) as { total: number };
    return { names: rows.map((r) => r.name), total };
  };

  beforeAll(() => {
    const trains = listEntry('train-supply', {
      title: 'Train Supply Manager',
      summary: 'Automates train deliveries',
      category: 'utilities',
      downloads_count: 5000,
      factorio: '2.0',
      releasedAt: '2026-05-01T00:00:00Z',
    });
    const planets = listEntry('more-planets', {
      title: 'More Planets',
      summary: 'Adds new planets to visit',
      category: 'content',
      downloads_count: 9000,
      requires_space_age: true,
      factorio: '2.0',
      releasedAt: '2026-08-01T00:00:00Z',
    });
    const legacy = listEntry('old-rails', {
      title: 'Old Rails',
      summary: 'Classic train tracks',
      category: 'content',
      downloads_count: 300,
      factorio: '1.1',
      releasedAt: '2022-01-01T00:00:00Z',
    });
    const ported = listEntry('ported-mod', {
      title: 'Ported',
      category: 'tweaks',
      downloads_count: 50,
      factorio: '2.0',
      releasedAt: '2025-01-01T00:00:00Z',
    });
    const dead = listEntry('dead-mod', { title: 'Dead train mod', downloads_count: 99999 });
    const vanilla = listEntry('vanilla-only', {
      title: 'Vanilla Only',
      category: 'tweaks',
      downloads_count: 10,
    });

    db = seedDb([
      {
        entry: trains,
        full: fullMod(trains, {
          tags: ['trains', 'logistics'],
          description: 'Schedules locomotives',
        }),
      },
      {
        entry: planets,
        full: fullMod(planets, { tags: ['planets'], dependencies: ['space-age'] }),
      },
      { entry: legacy, full: fullMod(legacy, { tags: ['trains'] }) },
      { entry: ported, full: fullMod(ported, { olderFactorio: ['1.1'] }) },
      { entry: dead, full: fullMod(dead, { deprecated: true }) },
      { entry: vanilla, full: fullMod(vanilla, { dependencies: ['base', '! space-age'] }) },
    ]);
  });

  it('hides deprecated mods by default and sorts by downloads', () => {
    expect(run().names).toEqual([
      'more-planets',
      'train-supply',
      'old-rails',
      'ported-mod',
      'vanilla-only',
    ]);
    expect(run({ hideDeprecated: false }).names[0]).toBe('dead-mod');
  });

  it('full-text searches name, title, summary and description', () => {
    expect(run({ q: 'train' }).names.sort()).toEqual(['old-rails', 'train-supply']);
    expect(run({ q: 'locomot' }).names).toEqual(['train-supply']);
    expect(run({ q: 'planet visit' }).names).toEqual(['more-planets']);
    expect(run({ q: '"' }).total).toBe(5);
  });

  it('ranks exact title matches first', () => {
    expect(run({ q: 'old rails' }).names[0]).toBe('old-rails');
  });

  it('filters by category and tags', () => {
    expect(run({ categories: ['content'] }).names).toEqual(['more-planets', 'old-rails']);
    expect(run({ tags: ['trains', 'logistics'] }).names).toEqual(['train-supply']);
    expect(run({ tags: ['planets', 'logistics'], tagMode: 'any' }).names).toEqual([
      'more-planets',
      'train-supply',
    ]);
  });

  it('matches Factorio versions on any release or the latest only', () => {
    expect(run({ factorioVersion: '1.1' }).names).toEqual(['old-rails', 'ported-mod']);
    expect(run({ factorioVersion: '1.1', versionMatch: 'latest' }).names).toEqual(['old-rails']);
  });

  it('filters by Space Age requirement', () => {
    expect(run({ spaceAge: 'required' }).names).toEqual(['more-planets']);
    expect(run({ spaceAge: 'excluded' }).names).not.toContain('more-planets');
    expect(run({ spaceAge: 'incompatible' }).names).toEqual(['vanilla-only']);
  });

  it('filters by downloads and update date', () => {
    expect(run({ minDownloads: 1000 }).names).toEqual(['more-planets', 'train-supply']);
    expect(run({ updatedSince: '2026-06-01' }).names).toEqual(['more-planets']);
  });

  it('sorts and paginates', () => {
    expect(run({ sort: 'title' }).names[0]).toBe('more-planets');
    expect(run({ sort: 'updated' }).names[0]).toBe('more-planets');
    const page2 = run({ pageSize: 2, page: 2 });
    expect(page2.names).toEqual(['old-rails', 'ported-mod']);
    expect(page2.total).toBe(5);
  });
});

describe('filter <-> URL params', () => {
  it('round-trips non-default values', () => {
    const input: ModFilterInput = {
      q: 'trains',
      categories: ['content', 'tweaks'],
      tags: ['trains'],
      factorioVersion: '2.0',
      hideDeprecated: false,
      minDownloads: 100,
      sort: 'downloads',
    };
    const params = filterToSearchParams(input);
    expect(params.toString()).toBe(
      'q=trains&category=content&category=tweaks&tag=trains&factorioVersion=2.0&hideDeprecated=0&minDownloads=100&sort=downloads',
    );
    expect(ModFilterSchema.parse(filterFromSearchParams(params))).toEqual(filter(input));
  });
});
