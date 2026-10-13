import { CATEGORY_LABELS } from '../../../src/shared/constants.ts';
import { SORTS, type Sort } from '../../../src/shared/filters.ts';
import type { ModSummary } from '../../../src/shared/types.ts';
import { clear, formatCount, h, timeAgo } from '../dom.ts';
import type { AppState } from '../main.ts';

export interface ResultActions {
  select: (name: string) => void;
  toggleInList: (name: string) => void;
  inList: (name: string) => boolean;
  loadMore: () => void;
  setSort: (sort: Sort) => void;
  clearFilters: () => void;
  startSync: () => void;
}

const SORT_LABELS: Record<Sort, string> = {
  relevance: 'Relevance',
  downloads: 'Most downloaded',
  score: 'Trending score',
  updated: 'Recently updated',
  created: 'Newest',
  title: 'Title (A–Z)',
};

export function thumbnail(url: string | null, size = 64): HTMLElement {
  return url
    ? h('img', { class: 'thumb', src: url, alt: '', loading: 'lazy', width: size, height: size })
    : h(
        'div',
        {
          class: 'thumb placeholder',
          style: `width:${size}px;height:${size}px;font-size:${size / 2.4}px`,
          'aria-hidden': 'true',
        },
        '⚙',
      );
}

function card(mod: ModSummary, state: AppState, actions: ResultActions): HTMLElement {
  const inList = actions.inList(mod.name);
  return h(
    'article',
    {
      class: `card${state.selected === mod.name ? ' selected' : ''}`,
      tabindex: 0,
      onclick: () => actions.select(mod.name),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') actions.select(mod.name);
      },
    },
    thumbnail(mod.thumbnailUrl),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'card-title' },
        h('h3', null, mod.title),
        h('span', { class: 'owner' }, `by ${mod.owner}`),
      ),
      h('p', { class: 'summary' }, mod.summary || h('em', { class: 'muted' }, 'No summary')),
      h(
        'div',
        { class: 'meta' },
        mod.similarity !== undefined
          ? h(
              'span',
              { class: 'pill match', title: 'How closely this mod matches the theme' },
              `${Math.round(mod.similarity * 100)}% match`,
            )
          : null,
        h(
          'span',
          { title: `${mod.downloadsCount.toLocaleString()} downloads` },
          `⬇ ${formatCount(mod.downloadsCount)}`,
        ),
        mod.factorioVersion ? h('span', { class: 'pill' }, mod.factorioVersion) : null,
        mod.requiresSpaceAge ? h('span', { class: 'pill sa' }, 'Space Age') : null,
        mod.deprecated ? h('span', { class: 'pill warn' }, 'Deprecated') : null,
        h('span', { class: 'pill cat' }, CATEGORY_LABELS[mod.category] ?? mod.category),
        h(
          'span',
          { class: 'muted', title: mod.latestReleaseAt ?? '' },
          `updated ${timeAgo(mod.latestReleaseAt)}`,
        ),
      ),
    ),
    h(
      'button',
      {
        class: `add${inList ? ' on' : ''}`,
        title: inList ? 'Remove from list' : 'Add to list',
        'aria-label': inList ? `Remove ${mod.title} from list` : `Add ${mod.title} to list`,
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.toggleInList(mod.name);
        },
      },
      inList ? '✓' : '+',
    ),
  );
}

export function renderResults(el: HTMLElement, state: AppState, actions: ResultActions): void {
  const sort = state.filter.sort ?? 'relevance';
  const header = h(
    'div',
    { class: 'results-head' },
    h(
      'span',
      { class: 'total', 'aria-live': 'polite' },
      state.loading && !state.results.length
        ? 'Searching…'
        : state.filter.semantic && !state.notice
          ? `${state.total.toLocaleString()} closest matches`
          : `${state.total.toLocaleString()} mods`,
    ),
    h(
      'label',
      { class: 'sort' },
      'Sort ',
      h(
        'select',
        { onchange: (e: Event) => actions.setSort((e.target as HTMLSelectElement).value as Sort) },
        SORTS.map((s) => h('option', { value: s, selected: s === sort }, SORT_LABELS[s])),
      ),
    ),
  );

  if (state.error) {
    clear(
      el,
      header,
      h('div', { class: 'empty' }, h('h2', null, 'Search failed'), h('p', null, state.error)),
    );
    return;
  }

  if (!state.loading && state.total === 0) {
    const emptyDb = !state.facets || state.facets.totals.mods === 0;
    clear(
      el,
      header,
      emptyDb
        ? h(
            'div',
            { class: 'empty' },
            h('h2', null, 'No mods downloaded yet'),
            h(
              'p',
              null,
              'Download the mod catalogue from the Factorio mod portal to start searching.',
            ),
            h('button', { class: 'btn primary', onclick: actions.startSync }, 'Download mod list'),
          )
        : h(
            'div',
            { class: 'empty' },
            h('h2', null, 'No mods match'),
            h('p', null, 'Try a broader search or fewer filters.'),
            h('button', { class: 'btn', onclick: actions.clearFilters }, 'Clear filters'),
          ),
    );
    return;
  }

  const more =
    state.results.length < state.total
      ? h(
          'button',
          { class: 'btn more', disabled: state.loading, onclick: actions.loadMore },
          state.loading
            ? 'Loading…'
            : `Show more (${(state.total - state.results.length).toLocaleString()} left)`,
        )
      : null;

  clear(
    el,
    header,
    state.notice ? h('p', { class: 'notice' }, state.notice) : null,
    h(
      'div',
      { class: `cards${state.loading ? ' loading' : ''}` },
      state.results.map((m) => card(m, state, actions)),
    ),
    more,
  );
}
