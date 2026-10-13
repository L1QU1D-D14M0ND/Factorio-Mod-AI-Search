import { describe, expect, it } from 'vitest';
import { renderExport, toModListJson } from '../src/core/export/formats.js';
import { resolveList } from '../src/core/export/resolve.js';
import { fullMod, listEntry, seedDb } from './helpers.js';

const lib = listEntry('my-lib', { title: 'My Lib' });
const core = listEntry('core-mod', { title: 'Core | Mod' });
const db = seedDb([
  { entry: lib, full: fullMod(lib, { dependencies: ['base >= 2.0'] }) },
  {
    entry: core,
    full: fullMod(core, {
      dependencies: ['base', 'my-lib >= 1.0', 'space-age', '? optional-thing', '! enemy'],
    }),
  },
]);

describe('resolveList', () => {
  it('follows required dependencies (including DLC) but never lists base', () => {
    const { mods } = resolveList(db, ['core-mod'], true);
    expect(mods.map((m) => [m.name, m.addedAsDependency])).toEqual([
      ['core-mod', false],
      ['my-lib', true],
      ['space-age', true],
      ['quality', true],
      ['elevated-rails', true],
    ]);
    expect(mods.find((m) => m.name === 'my-lib')?.requiredBy).toEqual(['core-mod']);
  });

  it('can skip dependencies and warns about unknown mods', () => {
    const { mods, warnings } = resolveList(db, ['core-mod', 'mystery', 'base'], false);
    expect(mods.map((m) => m.name)).toEqual(['core-mod', 'mystery']);
    expect(warnings).toEqual(['"mystery" is not in the local database.']);
  });
});

describe('formats', () => {
  const doc = {
    listName: 'My Pack!',
    ...resolveList(db, ['core-mod'], true),
    portalUrl: 'https://mods.factorio.com',
    generatedAt: new Date('2026-10-01T00:00:00Z'),
  };

  it('writes mod-list.json with base always enabled first', () => {
    const json = JSON.parse(toModListJson(doc)) as { mods: { name: string; enabled: boolean }[] };
    expect(json.mods[0]).toEqual({ name: 'base', enabled: true });
    expect(json.mods.map((m) => m.name)).toEqual([
      'base',
      'core-mod',
      'elevated-rails',
      'my-lib',
      'quality',
      'space-age',
    ]);
    expect(json.mods.every((m) => m.enabled)).toBe(true);
  });

  it('escapes markdown table cells and names files', () => {
    const md = renderExport('md', doc);
    expect(md.filename).toBe('my-pack.md');
    expect(md.body).toContain('[Core \\| Mod](https://mods.factorio.com/mod/core-mod)');
    expect(renderExport('mod-list', doc).filename).toBe('mod-list.json');
    expect(renderExport('txt', doc).body).toContain('My Lib (my-lib 1.0.0) [dependency]');
  });
});
