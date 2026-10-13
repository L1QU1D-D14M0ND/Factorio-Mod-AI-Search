import './styles.css';
import {
  filterFromSearchParams,
  filterToSearchParams,
  type ModFilterInput,
} from '../../src/shared/filters.ts';
import type { FacetsResponse, ListDetail, ModList, ModSummary } from '../../src/shared/types.ts';
import { api } from './api.ts';
import { clear, h } from './dom.ts';
import { renderDetail } from './views/detail.ts';
import { renderFilters } from './views/filters.ts';
import { renderListPanel } from './views/list-panel.ts';
import { renderResults } from './views/results.ts';
import { SyncBar } from './views/sync-bar.ts';
import { toast } from './views/toast.ts';

const ACTIVE_LIST_KEY = 'fmf.activeList';
const PAGE_SIZE = 30;

export interface AppState {
  filter: ModFilterInput;
  facets: FacetsResponse | null;
  results: ModSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  notice: string | null;
  selected: string | null;
  panel: 'detail' | 'list';
  lists: ModList[];
  activeList: ListDetail | null;
}

const state: AppState = {
  filter: filterFromSearchParams(new URLSearchParams(location.search)) as ModFilterInput,
  facets: null,
  results: [],
  total: 0,
  loading: false,
  error: null,
  notice: null,
  selected: new URLSearchParams(location.search).get('mod'),
  panel: 'detail',
  lists: [],
  activeList: null,
};

// ---------------------------------------------------------------------------
// Layout

const root = document.getElementById('app')!;
const filtersEl = h('aside', { class: 'sidebar', 'aria-label': 'Filters' });
const resultsEl = h('main', { class: 'results' });
const panelBody = h('div', { class: 'panel-body' });
const detailTab = h('button', { class: 'tab', onclick: () => showPanel('detail') }, 'Details');
const listTab = h('button', { class: 'tab', onclick: () => showPanel('list') }, 'My list');
const panelEl = h(
  'aside',
  { class: 'panel', 'aria-label': 'Details and lists' },
  h(
    'div',
    { class: 'tabs', role: 'tablist' },
    detailTab,
    listTab,
    h('button', { class: 'panel-close', title: 'Close', onclick: () => closePanel() }, '×'),
  ),
  panelBody,
);
// Two search modes share one input: keywords (FTS, `q`) and theme (embeddings, `semantic`).
type SearchMode = 'keywords' | 'theme';
let mode: SearchMode = state.filter.semantic ? 'theme' : 'keywords';
const PLACEHOLDERS: Record<SearchMode, string> = {
  keywords: 'Search mods by name, title or description…',
  theme: 'Describe what you want, e.g. “harder biters” or “compact trains”…',
};
const searchInput = h('input', {
  type: 'search',
  class: 'search',
  placeholder: PLACEHOLDERS[mode],
  value: (mode === 'theme' ? state.filter.semantic : state.filter.q) ?? '',
  'aria-label': 'Search mods',
});
const modeButtons = (['keywords', 'theme'] as const).map((m) =>
  h(
    'button',
    {
      class: 'seg',
      'aria-pressed': String(m === mode),
      title:
        m === 'theme'
          ? 'Find mods by meaning, not exact words'
          : 'Match words in names and descriptions',
      onclick: () => setMode(m),
    },
    m === 'theme' ? 'Theme' : 'Keywords',
  ),
);
const searchBox = h(
  'div',
  { class: 'search-box' },
  h('div', { class: 'segmented', role: 'group', 'aria-label': 'Search mode' }, modeButtons),
  searchInput,
);

function setMode(next: SearchMode): void {
  if (next === mode) return;
  mode = next;
  modeButtons.forEach((b, i) =>
    b.setAttribute('aria-pressed', String(['keywords', 'theme'][i] === mode)),
  );
  searchInput.placeholder = PLACEHOLDERS[mode];
  const text = searchInput.value.trim() || undefined;
  setFilter(mode === 'theme' ? { semantic: text, q: undefined } : { q: text, semantic: undefined });
  searchInput.focus();
}
const syncBar = new SyncBar(api, () => void refreshAfterSync());
const filterToggle = h(
  'button',
  {
    class: 'btn ghost filter-toggle',
    onclick: () => document.body.classList.toggle('show-filters'),
  },
  'Filters',
);

root.append(
  h(
    'header',
    { class: 'topbar' },
    h(
      'a',
      { class: 'brand', href: '/' },
      h('img', { src: '/favicon.svg', alt: '', width: 24, height: 24 }),
      h('span', null, 'Factorio Mod Finder'),
    ),
    filterToggle,
    searchBox,
    syncBar.el,
  ),
  h('div', { class: 'layout' }, filtersEl, resultsEl, panelEl),
);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const text = searchInput.value.trim() || undefined;
  searchTimer = setTimeout(
    () => setFilter(mode === 'theme' ? { semantic: text } : { q: text }),
    mode === 'theme' ? 400 : 250,
  );
});

// ---------------------------------------------------------------------------
// Search

let searchSeq = 0;

function setFilter(patch: Partial<ModFilterInput>, opts: { replace?: boolean } = {}): void {
  state.filter = { ...(opts.replace ? {} : state.filter), ...patch, page: undefined };
  for (const key of Object.keys(state.filter) as (keyof ModFilterInput)[]) {
    if (state.filter[key] === undefined) delete state.filter[key];
  }
  if (opts.replace) {
    mode = state.filter.semantic ? 'theme' : 'keywords';
    modeButtons.forEach((b, i) =>
      b.setAttribute('aria-pressed', String(['keywords', 'theme'][i] === mode)),
    );
    searchInput.placeholder = PLACEHOLDERS[mode];
    searchInput.value = (mode === 'theme' ? state.filter.semantic : state.filter.q) ?? '';
  }
  syncUrl();
  void search();
  renderSidebar();
}

async function search(append = false): Promise<void> {
  const seq = ++searchSeq;
  const page = append ? Math.floor(state.results.length / PAGE_SIZE) + 1 : 1;
  state.loading = true;
  state.error = null;
  renderMain();
  try {
    const res = await api.search({ ...state.filter, page, pageSize: PAGE_SIZE });
    if (seq !== searchSeq) return;
    state.results = append ? [...state.results, ...res.items] : res.items;
    state.total = res.total;
    state.notice = res.notice ?? null;
  } catch (err) {
    if (seq !== searchSeq) return;
    state.error = (err as Error).message;
  } finally {
    if (seq === searchSeq) {
      state.loading = false;
      renderMain();
    }
  }
}

function syncUrl(): void {
  const params = filterToSearchParams(state.filter);
  if (state.selected) params.set('mod', state.selected);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------------------
// Detail / list panel

function select(name: string): void {
  state.selected = name;
  syncUrl();
  showPanel('detail');
  renderMain();
}

function showPanel(panel: AppState['panel']): void {
  state.panel = panel;
  document.body.classList.add('show-panel');
  renderPanel();
}

function closePanel(): void {
  document.body.classList.remove('show-panel');
  state.selected = null;
  syncUrl();
  renderMain();
}

function renderPanel(): void {
  detailTab.classList.toggle('active', state.panel === 'detail');
  listTab.classList.toggle('active', state.panel === 'list');
  const count = state.activeList?.itemCount ?? 0;
  clear(listTab, 'My list', count ? h('span', { class: 'badge' }, String(count)) : null);

  if (state.panel === 'detail') {
    if (!state.selected) {
      clear(panelBody, h('p', { class: 'muted pad' }, 'Select a mod to see its details.'));
      return;
    }
    void renderDetail(panelBody, state.selected, {
      inList: (name) => isInList(name),
      toggleInList: (name) => void toggleInList(name),
      select,
      filterByTag: (tag) => setFilter({ tags: [tag] }),
      filterByOwner: (owner) => setFilter({ owner }),
    });
  } else {
    renderListPanel(panelBody, state, {
      switchList: (id) => void loadList(id),
      createList: () => void createList(),
      renameList: () => void renameList(),
      deleteList: () => void deleteList(),
      remove: (name) => void toggleInList(name),
      clearList: () => void clearList(),
      addDlc: (name) => void toggleInList(name),
      select,
    });
  }
}

// ---------------------------------------------------------------------------
// Lists (stored in the DB; only the active list id is remembered per browser)

function isInList(name: string): boolean {
  return !!state.activeList?.items.some((i) => i.name === name);
}

async function loadLists(): Promise<void> {
  state.lists = await api.lists();
  let id: number | null = null;
  try {
    id = Number(localStorage.getItem(ACTIVE_LIST_KEY)) || null;
  } catch {
    /* storage unavailable */
  }
  const target = state.lists.find((l) => l.id === id) ?? state.lists[0];
  state.activeList = target ? await api.list(target.id) : null;
}

async function loadList(id: number): Promise<void> {
  state.activeList = await api.list(id);
  try {
    localStorage.setItem(ACTIVE_LIST_KEY, String(id));
  } catch {
    /* storage unavailable */
  }
  renderAll();
}

async function ensureList(): Promise<ListDetail> {
  if (state.activeList) return state.activeList;
  const created = await api.createList('My mod list');
  state.lists = await api.lists();
  await loadList(created.id);
  return state.activeList!;
}

async function toggleInList(name: string): Promise<void> {
  try {
    const list = await ensureList();
    const inList = list.items.some((i) => i.name === name);
    state.activeList = inList
      ? await api.removeFromList(list.id, name)
      : await api.addToList(list.id, [name]);
    state.lists = state.lists.map((l) =>
      l.id === list.id ? { ...l, itemCount: state.activeList!.itemCount } : l,
    );
    if (!inList) toast(`Added to “${list.name}”`);
    renderAll();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function createList(): Promise<void> {
  const name = prompt('Name for the new list:', 'New mod list')?.trim();
  if (!name) return;
  const created = await api.createList(name);
  state.lists = await api.lists();
  await loadList(created.id);
}

async function renameList(): Promise<void> {
  const list = state.activeList;
  if (!list) return;
  const name = prompt('Rename list:', list.name)?.trim();
  if (!name || name === list.name) return;
  await api.renameList(list.id, name);
  state.lists = await api.lists();
  await loadList(list.id);
}

async function deleteList(): Promise<void> {
  const list = state.activeList;
  if (!list || !confirm(`Delete the list “${list.name}”? This cannot be undone.`)) return;
  await api.deleteList(list.id);
  state.activeList = null;
  await loadLists();
  renderAll();
}

async function clearList(): Promise<void> {
  const list = state.activeList;
  if (!list || !confirm(`Remove all mods from “${list.name}”?`)) return;
  state.activeList = await api.clearList(list.id);
  renderAll();
}

// ---------------------------------------------------------------------------
// Rendering

function renderSidebar(): void {
  renderFilters(filtersEl, state, {
    setFilter,
    reset: () => setFilter({}, { replace: true }),
  });
}

function renderMain(): void {
  renderResults(resultsEl, state, {
    select,
    toggleInList: (name) => void toggleInList(name),
    inList: isInList,
    loadMore: () => void search(true),
    setSort: (sort) => setFilter({ sort, order: undefined }),
    clearFilters: () => setFilter({}, { replace: true }),
    startSync: () => syncBar.start(),
  });
}

function renderAll(): void {
  renderSidebar();
  renderMain();
  renderPanel();
}

async function refreshAfterSync(): Promise<void> {
  state.facets = await api.facets();
  renderSidebar();
  await search();
}

// ---------------------------------------------------------------------------
// Boot

async function boot(): Promise<void> {
  if (state.selected) document.body.classList.add('show-panel');
  renderAll();
  const [facets] = await Promise.all([api.facets(), loadLists(), search()]);
  state.facets = facets;
  renderAll();
  syncBar.poll();
}

boot().catch((err: unknown) => {
  clear(
    resultsEl,
    h(
      'div',
      { class: 'empty' },
      h('h2', null, 'Cannot reach the local server'),
      h('p', null, String(err)),
    ),
  );
});
