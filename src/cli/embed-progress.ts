import type { ThemeSearch } from '../core/embeddings/service.js';

/** Runs an incremental embedding update with console progress output. */
export async function embedWithProgress(
  search: ThemeSearch,
  opts: { rebuild?: boolean; signal?: AbortSignal },
): Promise<void> {
  const isTTY = process.stdout.isTTY;
  let last = 0;
  const result = await search.update({
    ...opts,
    onProgress: (p) => {
      if (p.total === 0) return;
      const now = Date.now();
      if (!isTTY && now - last < 5000 && p.done < p.total) return;
      last = now;
      const line = `  embeddings ${p.done}/${p.total} (${((p.done / p.total) * 100).toFixed(0)}%)`;
      if (isTTY) process.stdout.write(`\r${line}`);
      else console.log(line);
    },
  });
  if (isTTY && result?.total) process.stdout.write('\n');
  if (result) {
    console.log(
      result.total
        ? `Embedded ${result.done} mods${result.rebuilt ? ' (index rebuilt for this model)' : ''}.`
        : 'Theme index is up to date.',
    );
  }
}
