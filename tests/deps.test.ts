import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  normalizeFactorioVersion,
  parseDependencies,
  parseDependency,
} from '../src/core/deps.js';

describe('parseDependency', () => {
  it.each([
    ['base >= 2.0.0', { name: 'base', kind: 'required', operator: '>=', version: '2.0.0' }],
    ['flib', { name: 'flib', kind: 'required', operator: null, version: null }],
    ['? some-mod > 0.4.3', { name: 'some-mod', kind: 'optional', operator: '>', version: '0.4.3' }],
    [
      '(?) Aircraft >= 1.6.6',
      { name: 'Aircraft', kind: 'hidden-optional', operator: '>=', version: '1.6.6' },
    ],
    ['! Krastorio', { name: 'Krastorio', kind: 'incompatible', operator: null, version: null }],
    ['~ mod-b', { name: 'mod-b', kind: 'no-load-order', operator: null, version: null }],
    [
      '+ ChangeInserterDropLane >= 1.3.0',
      { name: 'ChangeInserterDropLane', kind: 'recommended', operator: '>=', version: '1.3.0' },
    ],
    ['space-age = 2.0', { name: 'space-age', kind: 'required', operator: '=', version: '2.0' }],
    ['? mod <= 1', { name: 'mod', kind: 'optional', operator: '<=', version: '1' }],
    ['?mod-c<1.0.0', { name: 'mod-c', kind: 'optional', operator: '<', version: '1.0.0' }],
    ['!no-space', { name: 'no-space', kind: 'incompatible', operator: null, version: null }],
  ])('parses %j', (input, expected) => {
    expect(parseDependency(input)).toMatchObject({ ...expected, raw: input });
  });

  it('keeps spaces inside mod names', () => {
    expect(parseDependency('(?) Flow Control >= 3.0.5')).toMatchObject({
      name: 'Flow Control',
      kind: 'hidden-optional',
      version: '3.0.5',
    });
    expect(parseDependency('! Power Armor MK3')).toMatchObject({
      name: 'Power Armor MK3',
      kind: 'incompatible',
    });
  });

  it('does not treat a trailing number in a name as a version', () => {
    expect(parseDependency('Krastorio2')).toMatchObject({ name: 'Krastorio2', operator: null });
    expect(parseDependency('mod 2')).toMatchObject({ name: 'mod 2', operator: null });
  });

  it('trims surrounding whitespace', () => {
    expect(parseDependency('  ?   spaced-mod   >=   1.2.3  ')).toMatchObject({
      name: 'spaced-mod',
      kind: 'optional',
      operator: '>=',
      version: '1.2.3',
    });
  });

  it('returns null when there is no name', () => {
    expect(parseDependency('')).toBeNull();
    expect(parseDependency('?')).toBeNull();
    expect(parseDependency('(?)  ')).toBeNull();
  });
});

describe('parseDependencies', () => {
  it('skips invalid entries and duplicates', () => {
    const deps = parseDependencies(['base', 42, '', '? base', '! foo', null]);
    expect(deps.map((d) => [d.name, d.kind])).toEqual([
      ['base', 'required'],
      ['foo', 'incompatible'],
    ]);
  });

  it('handles missing lists', () => {
    expect(parseDependencies(undefined)).toEqual([]);
    expect(parseDependencies(null)).toEqual([]);
  });
});

describe('normalizeFactorioVersion', () => {
  it.each([
    ['2.0', '2.0'],
    ['2.1', '2.1'],
    ['0.14.22', '0.14'],
    ['1.00', '1.0'],
    ['01.01', '1.1'],
    ['2.10', '2.10'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeFactorioVersion(input)).toBe(expected);
  });

  it('rejects garbage', () => {
    expect(normalizeFactorioVersion(undefined)).toBeNull();
    expect(normalizeFactorioVersion('latest')).toBeNull();
    expect(normalizeFactorioVersion('2')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('2.10', '2.9')).toBeGreaterThan(0);
    expect(compareVersions('0.18', '1.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });
});
