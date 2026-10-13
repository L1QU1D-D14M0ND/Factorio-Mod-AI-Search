/** Mod portal categories (see https://wiki.factorio.com/Mod_details_API#Category). */
export const CATEGORIES = [
  'no-category',
  'content',
  'overhaul',
  'tweaks',
  'utilities',
  'scenarios',
  'mod-packs',
  'localizations',
  'internal',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  'no-category': 'No category',
  content: 'Content',
  overhaul: 'Overhaul',
  tweaks: 'Tweaks',
  utilities: 'Utilities',
  scenarios: 'Scenarios',
  'mod-packs': 'Mod packs',
  localizations: 'Localizations',
  internal: 'Internal',
};

/** The base game. Always enabled, never a "real" mod on the portal. */
export const BASE_MOD = 'base';

/**
 * Official expansion content. These are not on the mod portal but behave like mods:
 * they can be added to lists, and `space-age` requires the other two.
 */
export const OFFICIAL_DLC: Record<string, { title: string; requires: string[] }> = {
  'space-age': { title: 'Space Age', requires: ['quality', 'elevated-rails'] },
  quality: { title: 'Quality', requires: [] },
  'elevated-rails': { title: 'Elevated Rails', requires: [] },
};

export function isOfficialMod(name: string): boolean {
  return name === BASE_MOD || name in OFFICIAL_DLC;
}

export const DEPENDENCY_KINDS = [
  'required',
  'optional',
  'hidden-optional',
  'recommended',
  'incompatible',
  'no-load-order',
] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
