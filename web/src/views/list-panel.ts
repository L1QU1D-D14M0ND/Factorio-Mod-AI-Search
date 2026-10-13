import { OFFICIAL_DLC } from '../../../src/shared/constants.ts';
import { api } from '../api.ts';
import { clear, h } from '../dom.ts';
import type { AppState } from '../main.ts';
import { thumbnail } from './results.ts';

export interface ListActions {
  switchList: (id: number) => void;
  createList: () => void;
  renameList: () => void;
  deleteList: () => void;
  remove: (name: string) => void;
  clearList: () => void;
  addDlc: (name: string) => void;
  select: (name: string) => void;
}

const EXPORTS = [
  ['txt', '.txt'],
  ['md', '.md'],
  ['mod-list', 'mod-list.json'],
  ['print', 'PDF (print)'],
] as const;

let includeDeps = true;

export function renderListPanel(el: HTMLElement, state: AppState, actions: ListActions): void {
  const list = state.activeList;

  const picker = h(
    'div',
    { class: 'list-picker' },
    state.lists.length
      ? h(
          'select',
          {
            'aria-label': 'Active list',
            onchange: (e: Event) =>
              actions.switchList(Number((e.target as HTMLSelectElement).value)),
          },
          state.lists.map((l) =>
            h('option', { value: l.id, selected: l.id === list?.id }, `${l.name} (${l.itemCount})`),
          ),
        )
      : h('span', { class: 'muted' }, 'No lists yet'),
    h('button', { class: 'btn small', onclick: actions.createList }, 'New'),
    list ? h('button', { class: 'btn small ghost', onclick: actions.renameList }, 'Rename') : null,
    list
      ? h('button', { class: 'btn small ghost danger', onclick: actions.deleteList }, 'Delete')
      : null,
  );

  if (!list) {
    clear(
      el,
      h(
        'div',
        { class: 'list-panel' },
        picker,
        h('p', { class: 'muted pad' }, 'Add mods with the + button to start a list.'),
      ),
    );
    return;
  }

  const inList = new Set(list.items.map((i) => i.name));
  const dlcButtons = Object.entries(OFFICIAL_DLC)
    .filter(([name]) => !inList.has(name))
    .map(([name, dlc]) =>
      h('button', { class: 'chip', onclick: () => actions.addDlc(name) }, `+ ${dlc.title}`),
    );

  const exportBox = h(
    'div',
    { class: 'export' },
    h('h3', null, 'Export'),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: includeDeps,
        onchange: (e: Event) => {
          includeDeps = (e.target as HTMLInputElement).checked;
          renderListPanel(el, state, actions);
        },
      }),
      'Include required dependencies',
    ),
    h(
      'div',
      { class: 'export-buttons' },
      EXPORTS.map(([format, label]) =>
        h(
          'a',
          {
            class: `btn small${list.items.length ? '' : ' disabled'}`,
            href: list.items.length ? api.exportUrl(list.id, format, includeDeps) : undefined,
            // The print page opens in a new tab; the other formats download a file.
            ...(format === 'print'
              ? {
                  target: '_blank',
                  rel: 'noopener',
                  title: 'Opens a printable page: choose “Save as PDF”',
                }
              : { download: '' }),
          },
          label,
        ),
      ),
    ),
  );

  clear(
    el,
    h(
      'div',
      { class: 'list-panel' },
      picker,
      list.warnings.length
        ? h(
            'ul',
            { class: 'warnings' },
            list.warnings.map((w) => h('li', null, w)),
          )
        : null,
      list.items.length
        ? h(
            'ul',
            { class: 'list-items' },
            list.items.map((item) =>
              h(
                'li',
                null,
                item.official
                  ? h('div', { class: 'thumb small placeholder', 'aria-hidden': 'true' }, '★')
                  : thumbnail(item.thumbnailUrl, 40),
                h(
                  'div',
                  { class: 'grow' },
                  item.known && !item.official
                    ? h(
                        'button',
                        { class: 'link title', onclick: () => actions.select(item.name) },
                        item.title,
                      )
                    : h('span', { class: 'title' }, item.title),
                  h(
                    'div',
                    { class: 'muted small' },
                    item.official
                      ? 'Official DLC'
                      : [
                          item.latestVersion ? `v${item.latestVersion}` : '',
                          item.factorioVersion ? ` · Factorio ${item.factorioVersion}` : '',
                        ].join(''),
                  ),
                ),
                h(
                  'button',
                  {
                    class: 'icon',
                    title: 'Remove',
                    'aria-label': `Remove ${item.title}`,
                    onclick: () => actions.remove(item.name),
                  },
                  '×',
                ),
              ),
            ),
          )
        : h('p', { class: 'muted pad' }, 'This list is empty. Add mods with the + button.'),
      dlcButtons.length
        ? h('div', { class: 'dlc' }, h('span', { class: 'muted small' }, 'Expansion: '), dlcButtons)
        : null,
      list.items.length
        ? h(
            'button',
            { class: 'link danger', onclick: actions.clearList },
            'Remove all mods from this list',
          )
        : null,
      exportBox,
      h(
        'p',
        { class: 'hint' },
        'mod-list.json always enables the base game. Place it in your Factorio mods folder; mods still need to be downloaded in-game.',
      ),
    ),
  );
}
