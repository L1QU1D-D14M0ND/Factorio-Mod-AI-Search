import { CATEGORY_LABELS } from '../../../src/shared/constants.ts';
import type { ModFilterInput } from '../../../src/shared/filters.ts';
import { clear, formatCount, h } from '../dom.ts';
import type { AppState } from '../main.ts';

export interface FilterActions {
  setFilter: (patch: Partial<ModFilterInput>) => void;
  reset: () => void;
}

const DOWNLOAD_PRESETS = [0, 100, 1_000, 10_000, 100_000];
const UPDATED_PRESETS: [string, number][] = [
  ['Last month', 1],
  ['6 months', 6],
  ['1 year', 12],
  ['2 years', 24],
];

const tagLabel = (tag: string) => tag.replace(/-/g, ' ');

function monthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function section(title: string, ...body: (Node | null | false)[]): HTMLElement {
  return h('section', { class: 'filter-section' }, h('h3', null, title), ...body);
}

export function renderFilters(el: HTMLElement, state: AppState, actions: FilterActions): void {
  const f = state.filter;
  const facets = state.facets;
  const { setFilter } = actions;

  const versionSelect = h(
    'select',
    {
      'aria-label': 'Factorio version',
      onchange: (e: Event) =>
        setFilter({ factorioVersion: (e.target as HTMLSelectElement).value || undefined }),
    },
    h('option', { value: '' }, 'Any version'),
    (facets?.factorioVersions ?? []).map((v) =>
      h(
        'option',
        { value: v.value, selected: f.factorioVersion === v.value },
        `Factorio ${v.value}`,
      ),
    ),
  );

  const versionMatch = f.factorioVersion
    ? h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: f.versionMatch === 'latest',
          onchange: (e: Event) =>
            setFilter({
              versionMatch: (e.target as HTMLInputElement).checked ? 'latest' : undefined,
            }),
        }),
        'Latest release only',
      )
    : null;

  const spaceAge = h(
    'select',
    {
      'aria-label': 'Space Age',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value as ModFilterInput['spaceAge'];
        setFilter({ spaceAge: v === 'any' ? undefined : v });
      },
    },
    (
      [
        ['any', 'Any'],
        ['required', 'Requires Space Age'],
        ['excluded', 'Works without Space Age'],
        ['incompatible', 'Incompatible with Space Age'],
      ] as const
    ).map(([value, label]) =>
      h('option', { value, selected: (f.spaceAge ?? 'any') === value }, label),
    ),
  );

  const selectedCats = new Set(f.categories ?? []);
  const categories = h(
    'div',
    { class: 'checks' },
    (facets?.categories ?? []).map((c) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: selectedCats.has(c.value as never),
          onchange: (e: Event) => {
            const next = new Set(selectedCats);
            if ((e.target as HTMLInputElement).checked) next.add(c.value as never);
            else next.delete(c.value as never);
            setFilter({ categories: next.size ? [...next] : undefined });
          },
        }),
        h('span', null, CATEGORY_LABELS[c.value] ?? c.value),
        h('span', { class: 'count' }, formatCount(c.count)),
      ),
    ),
  );

  const selectedTags = new Set(f.tags ?? []);
  const tags = h(
    'div',
    { class: 'chips' },
    (facets?.tags ?? []).map((t) =>
      h(
        'button',
        {
          class: `chip${selectedTags.has(t.value) ? ' on' : ''}`,
          'aria-pressed': String(selectedTags.has(t.value)),
          onclick: () => {
            const next = new Set(selectedTags);
            if (next.has(t.value)) next.delete(t.value);
            else next.add(t.value);
            setFilter({ tags: next.size ? [...next] : undefined });
          },
        },
        tagLabel(t.value),
        h('span', { class: 'count' }, formatCount(t.count)),
      ),
    ),
  );
  const tagMode =
    selectedTags.size > 1
      ? h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: f.tagMode === 'any',
            onchange: (e: Event) =>
              setFilter({ tagMode: (e.target as HTMLInputElement).checked ? 'any' : undefined }),
          }),
          'Match any selected tag',
        )
      : null;

  const downloads = h(
    'select',
    {
      'aria-label': 'Minimum downloads',
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLSelectElement).value);
        setFilter({ minDownloads: v || undefined });
      },
    },
    DOWNLOAD_PRESETS.map((n) =>
      h(
        'option',
        { value: n, selected: (f.minDownloads ?? 0) === n },
        n ? `${formatCount(n)}+` : 'Any',
      ),
    ),
  );

  const updated = h('input', {
    type: 'date',
    value: f.updatedSince ?? '',
    'aria-label': 'Updated since',
    onchange: (e: Event) =>
      setFilter({ updatedSince: (e.target as HTMLInputElement).value || undefined }),
  });
  const updatedPresets = h(
    'div',
    { class: 'presets' },
    UPDATED_PRESETS.map(([label, months]) =>
      h(
        'button',
        { class: 'link', onclick: () => setFilter({ updatedSince: monthsAgo(months) }) },
        label,
      ),
    ),
    f.updatedSince
      ? h(
          'button',
          { class: 'link', onclick: () => setFilter({ updatedSince: undefined }) },
          'Clear',
        )
      : null,
  );

  const owner = f.owner
    ? section(
        'Author',
        h(
          'button',
          {
            class: 'chip on',
            title: 'Remove author filter',
            onclick: () => setFilter({ owner: undefined }),
          },
          f.owner,
          ' ×',
        ),
      )
    : null;

  const hideDeprecated = h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: f.hideDeprecated !== false,
      onchange: (e: Event) =>
        setFilter({ hideDeprecated: (e.target as HTMLInputElement).checked ? undefined : false }),
    }),
    'Hide deprecated mods',
  );

  const detailed = facets?.totals;
  clear(
    el,
    h(
      'div',
      { class: 'filter-head' },
      h('h2', null, 'Filters'),
      h('button', { class: 'link', onclick: actions.reset }, 'Reset all'),
    ),
    section('Factorio version', versionSelect, versionMatch),
    section('Space Age', spaceAge),
    owner,
    section('Category', categories),
    section('Tags', tags, tagMode),
    section('Downloads', downloads),
    section('Updated since', updated, updatedPresets),
    section('Other', hideDeprecated),
    detailed && detailed.detailed < detailed.mods
      ? h(
          'p',
          { class: 'hint' },
          `Tags, descriptions and release history are known for ${formatCount(detailed.detailed)} of ${formatCount(detailed.mods)} mods (those targeting the synced game version).`,
        )
      : null,
  );
}
