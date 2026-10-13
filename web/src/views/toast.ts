import { h } from '../dom.ts';

let container: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  if (!container) {
    container = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  container.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2500);
}
