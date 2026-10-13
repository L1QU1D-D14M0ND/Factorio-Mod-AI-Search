import { filterToSearchParams, type ModFilterInput } from '../../src/shared/filters.ts';
import type {
  AskResponse,
  ExplainResponse,
  SettingsResponse,
  FacetsResponse,
  ListDetail,
  ModDetail,
  ModList,
  SearchResponse,
  SyncStatus,
} from '../../src/shared/types.ts';

export type SettingsSection = 'llm' | 'embeddings';

/** A section as edited in the form. apiKey: undefined = keep saved key, null = remove it. */
export interface SectionDraft {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  apiKey?: string | null;
}

export type SettingsPatch = Partial<Record<SettingsSection, Partial<SectionDraft>>>;

/** Base URL of the local server. Empty = same origin (also works behind the Vite proxy). */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  search: (filter: ModFilterInput) =>
    request<SearchResponse>(`/api/mods?${filterToSearchParams(filter)}`),
  mod: (name: string) => request<ModDetail>(`/api/mods/${encodeURIComponent(name)}`),
  facets: () => request<FacetsResponse>('/api/facets'),

  ask: (prompt: string) => request<AskResponse>('/api/ask', json('POST', { prompt })),
  explain: (prompt: string, names: string[]) =>
    request<ExplainResponse>('/api/ask/explain', json('POST', { prompt, names })),

  settings: () => request<SettingsResponse>('/api/settings'),
  saveSettings: (patch: SettingsPatch) =>
    request<SettingsResponse>('/api/settings', json('PUT', patch)),
  testSettings: (section: SettingsSection, draft: SectionDraft) =>
    request<{ ok: boolean; message: string }>(
      '/api/settings/test',
      json('POST', { section, draft }),
    ),
  listModels: (section: SettingsSection, draft: SectionDraft) =>
    request<{ models: string[] }>('/api/settings/models', json('POST', { section, draft })),
  rebuildTheme: () => request<SyncStatus>('/api/theme/rebuild', json('POST', { rebuild: true })),

  syncStatus: () => request<SyncStatus>('/api/sync'),
  startSync: () => request<SyncStatus>('/api/sync', json('POST', {})),
  stopSync: () => request<SyncStatus>('/api/sync/stop', json('POST')),

  lists: () => request<ModList[]>('/api/lists'),
  list: (id: number) => request<ListDetail>(`/api/lists/${id}`),
  createList: (name: string) => request<ModList>('/api/lists', json('POST', { name })),
  renameList: (id: number, name: string) =>
    request<ModList>(`/api/lists/${id}`, json('PATCH', { name })),
  deleteList: (id: number) => request<void>(`/api/lists/${id}`, json('DELETE')),
  addToList: (id: number, names: string[]) =>
    request<ListDetail>(`/api/lists/${id}/items`, json('POST', { names })),
  removeFromList: (id: number, name: string) =>
    request<ListDetail>(`/api/lists/${id}/items/${encodeURIComponent(name)}`, json('DELETE')),
  clearList: (id: number) => request<ListDetail>(`/api/lists/${id}/items`, json('DELETE')),
  exportUrl: (id: number, format: string, deps: boolean) =>
    `${BASE}/api/lists/${id}/export?format=${format}&deps=${deps ? 1 : 0}`,
};
