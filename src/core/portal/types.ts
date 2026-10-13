// Shapes returned by the Factorio Mod Portal API.
// See https://wiki.factorio.com/Mod_portal_API. Fields "may be absent if there is no data".

export interface PortalRelease {
  download_url?: string;
  file_name?: string;
  info_json?: { factorio_version?: string; dependencies?: unknown[] };
  released_at?: string;
  version: string;
  sha1?: string;
  feature_flags?: string[];
}

export interface PortalListEntry {
  name: string;
  title?: string;
  owner?: string;
  summary?: string;
  category?: string;
  downloads_count?: number;
  score?: number;
  requires_space_age?: boolean;
  last_highlighted_at?: string;
  latest_release?: PortalRelease;
}

export interface PortalListResponse {
  pagination: unknown;
  results: PortalListEntry[];
}

export interface PortalLicense {
  id?: string;
  name?: string;
  title?: string;
  url?: string;
  description?: string;
}

export interface PortalFullMod extends PortalListEntry {
  description?: string;
  changelog?: string;
  faq?: string;
  created_at?: string;
  updated_at?: string;
  source_url?: string;
  github_path?: string;
  homepage?: string;
  tags?: string[];
  license?: PortalLicense;
  deprecated?: boolean;
  thumbnail?: string;
  releases?: PortalRelease[];
}
