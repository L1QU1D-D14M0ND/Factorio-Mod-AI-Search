import { BASE_MOD } from '../../shared/constants.js';
import type { ExportMod } from './resolve.js';

export const EXPORT_FORMATS = ['txt', 'md', 'mod-list', 'print'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportDocument {
  listName: string;
  mods: ExportMod[];
  warnings: string[];
  portalUrl: string;
  /** Base URL for thumbnails (print page only). */
  assetsUrl?: string;
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

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * A self-contained, print-friendly HTML page ("Save as PDF" from the browser's print
 * dialog). All mod text is escaped; the only script is the print button.
 */
export function toPrintHtml(doc: ExportDocument): string {
  const mods = [...doc.mods].sort(byTitle);
  const date = doc.generatedAt.toISOString().slice(0, 10);
  const rows = mods
    .map((m) => {
      const thumb =
        m.thumbnail && doc.assetsUrl
          ? `<img src="${escapeHtml(doc.assetsUrl + m.thumbnail)}" alt="" width="40" height="40">`
          : `<span class="ph">${m.official ? '★' : ''}</span>`;
      const title = m.official
        ? `${escapeHtml(m.title)} <span class="tag">DLC</span>`
        : `<a href="${escapeHtml(modUrl(doc.portalUrl, m.name))}">${escapeHtml(m.title)}</a>`;
      const dep = m.addedAsDependency
        ? `<div class="dep">Required by ${m.requiredBy.map(escapeHtml).join(', ')}</div>`
        : '';
      return `<tr>
  <td class="thumb">${thumb}</td>
  <td><strong>${title}</strong><div class="name">${escapeHtml(m.name)}</div>${dep}</td>
  <td>${escapeHtml(m.owner ?? '')}</td>
  <td class="nowrap">${escapeHtml(m.version ?? '')}</td>
  <td class="nowrap">${escapeHtml(m.factorioVersion ?? '')}</td>
  <td class="summary">${escapeHtml(m.summary)}</td>
</tr>`;
    })
    .join('\n');
  const warnings = doc.warnings.length
    ? `<section class="warnings"><h2>Warnings</h2><ul>${doc.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.listName)}</title>
<style>
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #fff; color: #1d1b19; font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; border-bottom: 2px solid #d97a00; padding-bottom: 8px; margin-bottom: 16px; }
  h1 { margin: 0; font-size: 22px; }
  .meta { color: #6f6961; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6f6961; border-bottom: 1px solid #ddd6cc; padding: 6px; }
  td { vertical-align: top; padding: 6px; border-bottom: 1px solid #eee8e0; }
  tr { break-inside: avoid; }
  .thumb { width: 52px; }
  .thumb img, .ph { display: block; width: 40px; height: 40px; border-radius: 4px; background: #f0ece6; object-fit: cover; text-align: center; line-height: 40px; color: #6f6961; }
  .name { color: #6f6961; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10px; }
  .dep { color: #a96d00; font-size: 10px; }
  .summary { color: #3b3834; }
  .nowrap { white-space: nowrap; }
  .tag { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: #f0ece6; color: #6f6961; }
  a { color: #1d1b19; text-decoration: none; }
  .warnings { margin-top: 16px; color: #a96d00; }
  .warnings h2 { font-size: 13px; margin: 0 0 4px; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; padding: 10px 12px; background: #fff4e5; border-radius: 6px; }
  .toolbar button { padding: 6px 14px; border: 0; border-radius: 6px; background: #d97a00; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  footer { margin-top: 16px; color: #6f6961; font-size: 10px; }
  @media print { body { padding: 0; } .toolbar { display: none; } a::after { content: none; } }
</style>
</head>
<body>
<div class="toolbar"><button id="print" type="button">Print / Save as PDF</button><span>Choose “Save as PDF” as the printer to get a PDF file.</span></div>
<header><h1>${escapeHtml(doc.listName)}</h1><div class="meta">${mods.length} mods · ${date}</div></header>
<table>
<thead><tr><th></th><th>Mod</th><th>Author</th><th>Version</th><th>Factorio</th><th>Summary</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${warnings}
<footer>Generated by Factorio Mod Finder · Mod data from mods.factorio.com</footer>
<script>document.getElementById('print').addEventListener('click', () => window.print());</script>
</body>
</html>
`;
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
    case 'print':
      return {
        filename: `${slug}.html`,
        contentType: 'text/html; charset=utf-8',
        body: toPrintHtml(doc),
      };
    case 'mod-list':
      return {
        filename: 'mod-list.json',
        contentType: 'application/json; charset=utf-8',
        body: toModListJson(doc),
      };
  }
}
