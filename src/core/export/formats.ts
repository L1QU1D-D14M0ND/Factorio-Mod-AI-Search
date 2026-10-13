import { BASE_MOD } from '../../shared/constants.js';
import type { ExportMod } from './resolve.js';

export const EXPORT_FORMATS = ['txt', 'md', 'mod-list'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportDocument {
  listName: string;
  mods: ExportMod[];
  warnings: string[];
  portalUrl: string;
  generatedAt: Date;
}

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string;
}

const modUrl = (portalUrl: string, name: string) => `${portalUrl}/mod/${encodeURIComponent(name)}`;

const byTitle = (a: ExportMod, b: ExportMod) =>
  Number(b.official) - Number(a.official) ||
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

/** Plain text: one mod per line, readable and easy to paste into chat. */
export function toTxt(doc: ExportDocument): string {
  const lines = [
    `# ${doc.listName}`,
    `# ${doc.mods.length} mods, exported ${doc.generatedAt.toISOString().slice(0, 10)}`,
    '',
  ];
  for (const m of [...doc.mods].sort(byTitle)) {
    const version = m.version ? ` ${m.version}` : '';
    const url = m.official ? '(official DLC)' : modUrl(doc.portalUrl, m.name);
    const dep = m.addedAsDependency ? ' [dependency]' : '';
    lines.push(`${m.title} (${m.name}${version})${dep} - ${url}`);
  }
  if (doc.warnings.length) lines.push('', ...doc.warnings.map((w) => `# Warning: ${w}`));
  return lines.join('\n') + '\n';
}

const escapeMd = (s: string) => s.replace(/[\\|`*_[\]<>]/g, '\\$&').replace(/\r?\n/g, ' ');

/** Markdown table, suitable for READMEs, forum posts or Discord. */
export function toMarkdown(doc: ExportDocument): string {
  const mods = [...doc.mods].sort(byTitle);
  const out = [
    `# ${escapeMd(doc.listName)}`,
    '',
    `${mods.length} mods · exported ${doc.generatedAt.toISOString().slice(0, 10)}`,
    '',
    '| Mod | Author | Version | Factorio | Summary |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const m of mods) {
    const title = m.official
      ? `${escapeMd(m.title)} *(DLC)*`
      : `[${escapeMd(m.title)}](${modUrl(doc.portalUrl, m.name)})`;
    const dep = m.addedAsDependency
      ? ` *(required by ${m.requiredBy.map((n) => `\`${n}\``).join(', ')})*`
      : '';
    out.push(
      `| ${title}${dep} | ${escapeMd(m.owner ?? '')} | ${m.version ?? ''} | ${m.factorioVersion ?? ''} | ${escapeMd(m.summary)} |`,
    );
  }
  if (doc.warnings.length)
    out.push('', '## Warnings', '', ...doc.warnings.map((w) => `- ${escapeMd(w)}`));
  return out.join('\n') + '\n';
}

/**
 * Factorio's `mods/mod-list.json`. `base` is the base game and always enabled; DLC are
 * listed like any other mod, enabled only if they are in the list (or required).
 */
export function toModListJson(doc: ExportDocument): string {
  const names = doc.mods
    .map((m) => m.name)
    .filter((n) => n !== BASE_MOD)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const mods = [
    { name: BASE_MOD, enabled: true },
    ...names.map((name) => ({ name, enabled: true })),
  ];
  return JSON.stringify({ mods }, null, 2) + '\n';
}

export function renderExport(format: ExportFormat, doc: ExportDocument): ExportFile {
  const slug =
    doc.listName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'mod-list';
  switch (format) {
    case 'txt':
      return {
        filename: `${slug}.txt`,
        contentType: 'text/plain; charset=utf-8',
        body: toTxt(doc),
      };
    case 'md':
      return {
        filename: `${slug}.md`,
        contentType: 'text/markdown; charset=utf-8',
        body: toMarkdown(doc),
      };
    case 'mod-list':
      return {
        filename: 'mod-list.json',
        contentType: 'application/json; charset=utf-8',
        body: toModListJson(doc),
      };
  }
}
