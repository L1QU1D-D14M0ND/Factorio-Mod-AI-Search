import type { DependencyKind } from '../shared/constants.js';

export type VersionOperator = '<' | '<=' | '=' | '>=' | '>';

export interface ParsedDependency {
  name: string;
  kind: DependencyKind;
  operator: VersionOperator | null;
  version: string | null;
  raw: string;
}

// Longest prefixes first so "(?)" wins over "?".
const PREFIXES: [string, DependencyKind][] = [
  ['(?)', 'hidden-optional'],
  ['!', 'incompatible'],
  ['?', 'optional'],
  ['+', 'recommended'],
  ['~', 'no-load-order'],
];

// Mod names may contain spaces (e.g. "Flow Control"), so the operator is matched
// from the end of the string rather than by splitting on whitespace.
const VERSION_SUFFIX = /\s*(<=|>=|<|>|=)\s*(\d+(?:\.\d+){0,2})\s*$/;

/**
 * Parses a Factorio info.json dependency string, e.g. `"? some-mod >= 1.2.0"`.
 * Format: `[prefix] name [operator version]`.
 * See https://lua-api.factorio.com/latest/auxiliary/mod-structure.html#dependencies
 *
 * Returns null for strings that do not contain a mod name.
 */
export function parseDependency(input: string): ParsedDependency | null {
  const raw = input;
  let rest = input.trim();
  let kind: DependencyKind = 'required';

  for (const [prefix, prefixKind] of PREFIXES) {
    if (rest.startsWith(prefix)) {
      kind = prefixKind;
      rest = rest.slice(prefix.length).trim();
      break;
    }
  }

  let operator: VersionOperator | null = null;
  let version: string | null = null;
  const match = VERSION_SUFFIX.exec(rest);
  if (match) {
    operator = match[1] as VersionOperator;
    version = match[2] ?? null;
    rest = rest.slice(0, match.index).trim();
  }

  if (!rest) return null;
  // Incompatibilities ignore versions in-game; keep them anyway for display.
  return { name: rest, kind, operator, version, raw };
}

export function parseDependencies(list: readonly unknown[] | undefined | null): ParsedDependency[] {
  if (!Array.isArray(list)) return [];
  const out: ParsedDependency[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const dep = parseDependency(item);
    if (!dep) continue;
    // A mod can only reference another mod once; keep the first occurrence.
    if (seen.has(dep.name)) continue;
    seen.add(dep.name);
    out.push(dep);
  }
  return out;
}

/**
 * Normalizes messy `factorio_version` strings to a "major.minor" key.
 * Examples: "2.0" -> "2.0", "0.14.22" -> "0.14", "1.00" -> "1.0", "01.01" -> "1.1".
 * Returns null when the value is not a recognizable version.
 */
export function normalizeFactorioVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+)\.(\d+)(?:\.\d+)?\s*$/.exec(value);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}`;
}

/** Numeric comparison of "major.minor[.patch]" version strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
