import type { SectionSettings, SettingsResponse } from '../../../src/shared/types.ts';
import { api, type SectionDraft, type SettingsSection } from '../api.ts';
import { clear, h } from '../dom.ts';
import { toast } from './toast.ts';

const LLM_PROVIDERS: [string, string][] = [
  ['none', 'Off'],
  ['openai', 'OpenAI-compatible (Ollama, LM Studio, llama.cpp, OpenRouter, OpenAI)'],
  ['anthropic', 'Anthropic (Claude)'],
];

const EMBEDDING_PROVIDERS: [string, string][] = [
  ['transformers', 'Local, built in (transformers.js)'],
  ['ollama', 'Ollama'],
  ['openai', 'OpenAI-compatible (LM Studio, llama.cpp, OpenAI…)'],
  ['none', 'Off'],
];

/** One-click base URLs for OpenAI-compatible servers. */
const LLM_PRESETS: [string, string][] = [
  ['Ollama', 'http://127.0.0.1:11434/v1'],
  ['LM Studio', 'http://127.0.0.1:1234/v1'],
  ['llama.cpp', 'http://127.0.0.1:8080/v1'],
  ['OpenRouter', 'https://openrouter.ai/api/v1'],
  ['OpenAI', 'https://api.openai.com/v1'],
];

const LOCKED_TITLE = 'Set by an environment variable (.env); change it there.';

interface SectionForm {
  el: HTMLElement;
  draft(): SectionDraft;
  /** Only the fields the user may change, for saving. */
  patch(): Partial<SectionDraft>;
  changed(): boolean;
}

function sectionForm(
  section: SettingsSection,
  saved: SectionSettings,
  defaults: SettingsResponse['defaults'][SettingsSection],
  providers: [string, string][],
): SectionForm {
  const locked = new Set(saved.locked);
  const id = (field: string) => `settings-${section}-${field}`;
  const status = h('p', { class: 'test-status', role: 'status' });
  const modelList = h('datalist', { id: id('models') });

  const provider = h(
    'select',
    {
      id: id('provider'),
      disabled: locked.has('provider'),
      title: locked.has('provider') ? LOCKED_TITLE : undefined,
    },
    providers.map(([value, label]) =>
      h('option', { value, selected: value === saved.provider }, label),
    ),
  );
  const baseUrl = h('input', {
    id: id('baseUrl'),
    type: 'url',
    value: saved.baseUrl ?? '',
    disabled: locked.has('baseUrl'),
    title: locked.has('baseUrl') ? LOCKED_TITLE : undefined,
    spellcheck: false,
  });
  const model = h('input', {
    id: id('model'),
    type: 'text',
    value: saved.model ?? '',
    list: id('models'),
    disabled: locked.has('model'),
    title: locked.has('model') ? LOCKED_TITLE : undefined,
    spellcheck: false,
  });
  const apiKey = h('input', {
    id: id('apiKey'),
    type: 'password',
    autocomplete: 'off',
    placeholder: saved.apiKeySet ? 'Saved (leave empty to keep it)' : 'Not set',
    disabled: locked.has('apiKey'),
    title: locked.has('apiKey') ? LOCKED_TITLE : undefined,
  });
  const removeKey = h('input', { type: 'checkbox' });
  const removeKeyLabel =
    saved.apiKeySet && !locked.has('apiKey')
      ? h('label', { class: 'check small' }, removeKey, 'Remove the saved key')
      : null;

  const presets =
    section === 'llm'
      ? h(
          'div',
          { class: 'presets' },
          h('span', { class: 'muted small' }, 'Presets:'),
          LLM_PRESETS.map(([label, url]) =>
            h(
              'button',
              {
                type: 'button',
                class: 'link',
                disabled: locked.has('baseUrl'),
                onclick: () => {
                  baseUrl.value = url;
                  update();
                },
              },
              label,
            ),
          ),
        )
      : null;

  const fields = h('div', { class: 'fields' });
  const draft = (): SectionDraft => ({
    provider: provider.value,
    baseUrl: baseUrl.value.trim() || null,
    model: model.value.trim() || null,
    apiKey: removeKey.checked ? null : apiKey.value.trim() || undefined,
  });

  function update(): void {
    const p = provider.value;
    const d = defaults[p];
    const off = p === 'none';
    const needsUrl = !off && p !== 'transformers';
    const needsKey = p === 'anthropic' || p === 'openai';
    baseUrl.placeholder = d?.baseUrl ?? '';
    model.placeholder =
      d?.model ?? (section === 'llm' ? 'Model name (required), e.g. qwen2.5:7b' : '');
    clear(
      fields,
      needsUrl
        ? h('label', { for: id('baseUrl') }, 'Base URL', baseUrl, p === 'openai' ? presets : null)
        : null,
      !off
        ? h(
            'label',
            { for: id('model') },
            'Model',
            h('div', { class: 'row' }, model, needsUrl ? loadModels : null),
            modelList,
          )
        : null,
      !off && needsKey
        ? h(
            'label',
            { for: id('apiKey') },
            'API key',
            h(
              'span',
              { class: 'muted small' },
              p === 'openai' ? ' (not needed for local servers)' : '',
            ),
            apiKey,
            removeKeyLabel,
          )
        : null,
      !off ? h('div', { class: 'row' }, testButton, status) : null,
    );
  }

  const loadModels = h(
    'button',
    {
      type: 'button',
      class: 'btn small',
      onclick: async () => {
        loadModels.disabled = true;
        try {
          const { models } = await api.listModels(section, draft());
          clear(
            modelList,
            models.map((m) => h('option', { value: m })),
          );
          status.className = 'test-status';
          status.textContent = models.length
            ? `${models.length} models found. Pick one in the Model field.`
            : 'No models found.';
        } catch (err) {
          status.className = 'test-status error';
          status.textContent = (err as Error).message;
        } finally {
          loadModels.disabled = false;
        }
      },
    },
    'Load models',
  );

  const testButton = h(
    'button',
    {
      type: 'button',
      class: 'btn small',
      onclick: async () => {
        testButton.disabled = true;
        status.className = 'test-status';
        status.textContent =
          provider.value === 'transformers'
            ? 'Testing… (the first time downloads the model, ~23 MB)'
            : 'Testing…';
        try {
          const res = await api.testSettings(section, draft());
          status.className = `test-status ${res.ok ? 'ok' : 'error'}`;
          status.textContent = res.message;
        } catch (err) {
          status.className = 'test-status error';
          status.textContent = (err as Error).message;
        } finally {
          testButton.disabled = false;
        }
      },
    },
    'Test connection',
  );

  provider.addEventListener('change', update);
  update();

  const initial = JSON.stringify(draft());
  return {
    el: h('div', null, h('label', { for: id('provider') }, 'Provider', provider), fields),
    draft,
    changed: () => JSON.stringify(draft()) !== initial,
    patch: () => {
      // Only send what changed, so untouched defaults are not written to config.json.
      const d = draft();
      const out: Partial<SectionDraft> = {};
      if (!locked.has('provider') && d.provider !== saved.provider) out.provider = d.provider;
      if (!locked.has('baseUrl') && d.baseUrl !== saved.baseUrl) out.baseUrl = d.baseUrl;
      if (!locked.has('model') && d.model !== saved.model) out.model = d.model;
      if (!locked.has('apiKey') && d.apiKey !== undefined) out.apiKey = d.apiKey;
      return out;
    },
  };
}

/**
 * Settings dialog for the AI assistant (natural-language search) and theme search
 * (embeddings). Saved to config.json on this computer; API keys never come back to the page.
 */
export async function openSettings(onSaved: (settings: SettingsResponse) => void): Promise<void> {
  let settings: SettingsResponse;
  try {
    settings = await api.settings();
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }

  const llm = sectionForm('llm', settings.llm, settings.defaults.llm, LLM_PROVIDERS);
  const embeddings = sectionForm(
    'embeddings',
    settings.embeddings,
    settings.defaults.embeddings,
    EMBEDDING_PROVIDERS,
  );
  const error = h('p', { class: 'error small', role: 'alert' });

  const dialog = h('dialog', { class: 'settings', 'aria-labelledby': 'settings-title' });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const save = h(
    'button',
    {
      type: 'submit',
      class: 'btn primary',
      onclick: async (e: Event) => {
        e.preventDefault();
        save.disabled = true;
        error.textContent = '';
        const embeddingsChanged = embeddings.changed();
        try {
          const saved = await api.saveSettings({
            llm: llm.patch(),
            embeddings: embeddings.patch(),
          });
          close();
          onSaved(saved);
          if (embeddingsChanged && saved.status.theme.enabled && !saved.status.theme.ready) {
            if (
              confirm(
                'The theme index must be rebuilt for the new embedding settings. Rebuild it now?',
              )
            ) {
              await api.rebuildTheme().catch((err: Error) => toast(err.message, 'error'));
            }
          }
          toast('Settings saved');
        } catch (err) {
          error.textContent = (err as Error).message;
        } finally {
          save.disabled = false;
        }
      },
    },
    'Save',
  );

  const themeStatus = settings.status.theme;
  dialog.append(
    h(
      'form',
      { method: 'dialog' },
      h(
        'header',
        null,
        h('h2', { id: 'settings-title' }, 'Settings'),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: close }, '×'),
      ),
      h(
        'section',
        null,
        h('h3', null, 'AI assistant'),
        h(
          'p',
          { class: 'muted small' },
          'Used by “Ask AI” to turn a request into search filters, and to explain results when you ask. It never reads your database.',
        ),
        llm.el,
        h(
          'p',
          { class: `small ${settings.status.llm.ready ? 'ok' : 'muted'}` },
          settings.status.llm.ready
            ? `Currently in use: ${settings.status.llm.message}`
            : `Currently off. ${settings.status.llm.message}`,
        ),
      ),
      h(
        'section',
        null,
        h('h3', null, 'Theme search'),
        h(
          'p',
          { class: 'muted small' },
          'An embedding model turns mod titles and summaries into vectors so they can be matched by meaning. Separate from the AI assistant.',
        ),
        embeddings.el,
        h(
          'p',
          { class: `small ${themeStatus.ready ? 'ok' : 'muted'}` },
          themeStatus.ready
            ? `Index: ${themeStatus.indexed.toLocaleString()} mods (${themeStatus.provider})`
            : (themeStatus.reason ?? ''),
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        'Saved to config.json on this computer (not in git). API keys are never shown again after saving.',
      ),
      error,
      h(
        'footer',
        null,
        h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Cancel'),
        save,
      ),
    ),
  );
  dialog.addEventListener('cancel', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
