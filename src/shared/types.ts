// API response types shared by the server and the web UI.
import type { DependencyKind } from './constants.js';

export interface ModSummary {
  name: string;
  title: string;
  owner: string;
  summary: string;
  category: string;
  downloadsCount: number;
  score: number;
  latestVersion: string | null;
  latestReleaseAt: string | null;
  factorioVersion: string | null;
  createdAt: string | null;
  requiresSpaceAge: boolean;
  incompatibleSpaceAge: boolean;
  deprecated: boolean;
  thumbnailUrl: string | null;
  tags: string[];
  /** False until /full details were synced (no description, tags or dependencies yet). */
  hasDetails: boolean;
  removed: boolean;
  /** Theme-search similarity (0..1), only present for theme searches. */
  similarity?: number;
}

export interface SearchResponse {
  /** Shown to the user, e.g. when theme search fell back to keyword search. */
  notice?: string;
  total: number;
  page: number;
  pageSize: number;
  items: ModSummary[];
}

export interface DependencyInfo {
  name: string;
  kind: DependencyKind;
  operator: string | null;
  version: string | null;
  /** Title if the dependency is known locally (mod in DB or official DLC). */
  title: string | null;
  official: boolean;
  known: boolean;
}

export interface ModDetail extends ModSummary {
  description: string;
  updatedAt: string | null;
  sourceUrl: string | null;
  homepage: string | null;
  license: { id: string | null; title: string | null; url: string | null };
  featureFlags: string[];
  portalUrl: string;
  releases: { version: string; factorioVersion: string | null; releasedAt: string | null }[];
  dependencies: DependencyInfo[];
  /** Most-downloaded mods that hard-require this one. */
  requiredBy: { name: string; title: string; downloadsCount: number }[];
  requiredByCount: number;
  /** Set when full details were needed but could not be fetched from the portal. */
  detailsError?: string;
}

export interface ThemeStatus {
  enabled: boolean;
  provider: string | null;
  ready: boolean;
  indexed: number;
  mods: number;
  reason: string | null;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface SyncStatus {
  running: boolean;
  progress: {
    phase: string;
    queued: number;
    done: number;
    failed: number;
    message: string | null;
  } | null;
  lastListSync: string | null;
  lastCompleted: string | null;
  gameVersion: string | null;
  pending: number;
  error: string | null;
}

export interface FacetsResponse {
  categories: FacetCount[];
  tags: FacetCount[];
  factorioVersions: FacetCount[];
  totals: { mods: number; detailed: number };
}

export interface ModList {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface ListItem {
  name: string;
  title: string;
  official: boolean;
  known: boolean;
  summary: string;
  latestVersion: string | null;
  factorioVersion: string | null;
  thumbnailUrl: string | null;
  addedAt: string;
}

export interface ListDetail extends ModList {
  items: ListItem[];
  warnings: string[];
}
