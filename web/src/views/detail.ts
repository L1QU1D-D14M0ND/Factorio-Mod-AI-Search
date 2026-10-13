import { CATEGORY_LABELS, type DependencyKind } from '../../../src/shared/constants.ts';
import type { DependencyInfo, ModDetail } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { clear, formatCount, formatDate, h } from '../dom.ts';
import { thumbnail } from './results.ts';

export interface DetailActions {
  inList: (name: string) => boolean;
  toggleInList: (name: string) => void;
  select: (name: string) => void;
  filterByTag: (tag: string) => void;
  filterByOwner: (owner: string) => void;
}

const DEP_GROUPS: { title: string; kinds: DependencyKind[]; className: string }[] = [
  { title: 'Requires', kinds: ['required', 'no-load-order'], className: 'req' },
  { title: 'Recommended', kinds: ['recommended'], className: 'rec' },
  { title: 'Optional', kinds: ['optional', 'hidden-optional'], className: 'opt' },
  { title: 'Incompatible with', kinds: ['incompatible'], className: 'bad' },
];

const cache = new Map<string, ModDetail>();
let current: string | null = null;

function depItem(dep: DependencyInfo, actions: DetailActions): HTMLElement {
  const version =
    dep.operator && dep.kind !== 'incompatible' ? ` ${dep.operator} ${dep.version}` : '';
  const label = dep.title && dep.title !== dep.name ? `${dep.title} (${dep.name})` : dep.name;
  const notes = [
    dep.kind === 'hidden-optional' ? 'hidden' : null,
    dep.kind === 'no-load-order' ? 'no load order effect' : null,
    dep.official ? 'official' : null,
    !dep.known ? 'not in local DB' : null,
  ].filter(Boolean);
  const name =
    dep.known && !dep.official
      ? h('button', { class: 'link', onclick: () => actions.select(dep.name) }, label)
      : h('span', null, label);
  return h(
    'li',
    null,
    name,
    version ? h('span', { class: 'muted' }, version) : null,
    notes.length ? h('span', { class: 'note' }, ` · ${notes.join(', ')}`) : null,
  );
}

function link(href: string | null, label: string): HTMLElement | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return h(
    'a',
    { href, target: '_blank', rel: 'noopener noreferrer', class: 'btn ghost small' },
    label,
  );
}

function render(el: HTMLElement, mod: ModDetail, actions: DetailActions): void {
  const inList = actions.inList(mod.name);
  const supported = [...new Set(mod.releases.map((r) => r.factorioVersion).filter(Boolean))];

  const deps = DEP_GROUPS.map((g) => {
    const items = mod.dependencies.filter((d) => g.kinds.includes(d.kind) && d.name !== 'base');
    return items.length
      ? h(
          'div',
          { class: `deps ${g.className}` },
          h('h4', null, `${g.title} (${items.length})`),
          h(
            'ul',
            null,
            items.map((d) => depItem(d, actions)),
          ),
        )
      : null;
  }).filter(Boolean);

  clear(
    el,
    h(
      'div',
      { class: 'detail' },
      h(
        'div',
        { class: 'detail-head' },
        thumbnail(mod.thumbnailUrl, 96),
        h(
          'div',
          null,
          h('h2', null, mod.title),
          h(
            'p',
            { class: 'muted' },
            h('code', null, mod.name),
            ' by ',
            h(
              'button',
              { class: 'link', onclick: () => actions.filterByOwner(mod.owner) },
              mod.owner,
            ),
          ),
          h(
            'div',
            { class: 'meta' },
            h('span', null, `⬇ ${mod.downloadsCount.toLocaleString()}`),
            mod.latestVersion ? h('span', { class: 'pill' }, `v${mod.latestVersion}`) : null,
            mod.factorioVersion
              ? h('span', { class: 'pill' }, `Factorio ${mod.factorioVersion}`)
              : null,
            mod.requiresSpaceAge ? h('span', { class: 'pill sa' }, 'Requires Space Age') : null,
            mod.incompatibleSpaceAge ? h('span', { class: 'pill warn' }, 'No Space Age') : null,
            mod.deprecated ? h('span', { class: 'pill warn' }, 'Deprecated') : null,
            mod.removed ? h('span', { class: 'pill warn' }, 'Removed from portal') : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: `btn ${inList ? '' : 'primary'}`,
            onclick: () => actions.toggleInList(mod.name),
          },
          inList ? '✓ In list (remove)' : '+ Add to list',
        ),
        link(mod.portalUrl, 'Mod portal ↗'),
        link(mod.sourceUrl, 'Source ↗'),
        mod.homepage !== mod.sourceUrl ? link(mod.homepage, 'Homepage ↗') : null,
      ),
      h('p', { class: 'lead' }, mod.summary),
      mod.detailsError || !mod.hasDetails
        ? h(
            'p',
            { class: 'hint' },
            mod.detailsError ?? 'Full details are not available for this mod.',
            ' ',
            h(
              'a',
              { href: mod.portalUrl, target: '_blank', rel: 'noopener noreferrer' },
              'View it on the mod portal ↗',
            ),
          )
        : null,
      mod.tags.length
        ? h(
            'div',
            { class: 'chips' },
            mod.tags.map((t) =>
              h(
                'button',
                {
                  class: 'chip',
                  title: 'Filter by this tag',
                  onclick: () => actions.filterByTag(t),
                },
                t.replace(/-/g, ' '),
              ),
            ),
          )
        : null,
      h(
        'dl',
        { class: 'facts' },
        h('dt', null, 'Category'),
        h('dd', null, CATEGORY_LABELS[mod.category] ?? mod.category),
        h('dt', null, 'Updated'),
        h('dd', null, formatDate(mod.latestReleaseAt)),
        h('dt', null, 'Created'),
        h('dd', null, formatDate(mod.createdAt)),
        supported.length ? h('dt', null, 'Factorio') : null,
        supported.length ? h('dd', null, supported.join(', ')) : null,
        mod.license.title ? h('dt', null, 'License') : null,
        mod.license.title ? h('dd', null, mod.license.title) : null,
        mod.featureFlags.length ? h('dt', null, 'Features') : null,
        mod.featureFlags.length ? h('dd', null, mod.featureFlags.join(', ')) : null,
      ),
      deps.length ? h('section', null, h('h3', null, 'Dependencies'), deps) : null,
      mod.requiredByCount
        ? h(
            'section',
            null,
            h(
              'h3',
              null,
              `Required by ${mod.requiredByCount} mod${mod.requiredByCount === 1 ? '' : 's'}`,
            ),
            h(
              'ul',
              { class: 'plain' },
              mod.requiredBy.map((r) =>
                h(
                  'li',
                  null,
                  h('button', { class: 'link', onclick: () => actions.select(r.name) }, r.title),
                  h('span', { class: 'muted' }, ` · ⬇ ${formatCount(r.downloadsCount)}`),
                ),
              ),
              mod.requiredByCount > mod.requiredBy.length
                ? h(
                    'li',
                    { class: 'muted' },
                    `…and ${mod.requiredByCount - mod.requiredBy.length} more`,
                  )
                : null,
            ),
          )
        : null,
      mod.description
        ? h(
            'section',
            null,
            h('h3', null, 'Description'),
            h('div', { class: 'description' }, mod.description),
          )
        : null,
    ),
  );
}

export async function renderDetail(
  el: HTMLElement,
  name: string,
  actions: DetailActions,
): Promise<void> {
  current = name;
  const cached = cache.get(name);
  if (cached) {
    render(el, cached, actions);
    return;
  }
  clear(el, h('p', { class: 'muted pad' }, 'Loading…'));
  try {
    const mod = await api.mod(name);
    if (!mod.detailsError) cache.set(name, mod);
    if (current === name) {
      render(el, mod, actions);
      el.scrollTop = 0;
    }
  } catch (err) {
    if (current === name) clear(el, h('p', { class: 'pad error' }, (err as Error).message));
  }
}

/** Forget cached details (e.g. after a sync). */
export function clearDetailCache(): void {
  cache.clear();
}
