# Factorio Mod Finder

A local, open-source tool to search the [Factorio mod portal](https://mods.factorio.com) with
real filters, full-text search, dependency info and exportable mod lists.

- Runs entirely on your machine: a small Node.js server plus a web UI at `http://localhost:3000`.
- Works **without any AI**. Theme search runs a small embedding model locally (no account, no API
  key) and can be switched to Ollama or an OpenAI-compatible API, or turned off.
- Keeps its own copy of the mod catalogue in a single SQLite file and only contacts the
  portal when you ask it to refresh.

## Features

- **Keyword search** by name, title, summary and description (SQLite FTS5, ranked by relevance and
  popularity).
- **Theme search**: describe what you want ("harder biters", "ocean planet", "compact trains")
  and get mods with a similar meaning, even if they use different words. Combines with all filters.
- **Filters**: Factorio version (any release or latest only), Space Age (required / works
  without / incompatible), category, tags, author, minimum downloads, updated since, hide deprecated.
- **Sorting** by relevance, downloads, trending score, last update, creation date or title.
- **Mod details**: description, tags, license, supported Factorio versions, dependencies grouped as
  requires / recommended / optional / incompatible, and the most popular mods that require it.
  Details that were not synced are fetched from the portal when you open the mod (one request),
  with a link to the mod portal as a fallback.
- **Saved lists** stored in the database, with conflict and missing-mod warnings.
- **Export** a list to `.txt`, `.md` or Factorio's `mod-list.json`, optionally adding all required
  dependencies (resolved recursively, DLC included).

## Requirements

- Node.js **22.13 or newer** (22 LTS or 24 LTS)
- On most systems `better-sqlite3` installs a prebuilt binary. If it has to compile, you need
  Python 3 and a C++ toolchain (build-essential / Xcode CLT / Visual Studio Build Tools).

## Getting started

```bash
npm install
npm run sync     # download the mod catalogue and build the theme index (see below)
npm start        # build the UI and serve it at http://localhost:3000
```

The project's `.npmrc` tells `onnxruntime-node` (used for local embeddings) to skip its optional
CUDA download; it runs on the CPU.

You can also start the app first and press **Refresh** in the top bar instead of running
`npm run sync`.

### How syncing works

1. **Mod list**: one request to `/api/mods?page_size=max` returns every mod on the portal
   (~24,000) with its summary, category, downloads and latest release. This alone makes every mod
   searchable by name, title and summary.
2. **Details**: for mods targeting the chosen game version (by default the **latest** Factorio
   version, or newer), it fetches `/api/mods/{name}/full` to get descriptions, tags, release
   history and dependencies. The first run for the latest version is a few thousand requests,
   about 25 minutes at the default 3 requests/second.
3. **Incremental refresh**: later syncs download the list again and only fetch details for mods
   that are new or have a new release. This usually takes a minute or two.
4. **Theme index**: after a sync, mods whose title or summary changed are embedded for theme
   search. The first time downloads the model (~23 MB) and embeds every mod, which takes 1–2
   minutes on a typical CPU; after that it only takes seconds.

Mods outside the synced game version are still fully searchable by keywords and theme (title and
summary). Their description, tags and dependencies are fetched when you open them.

Syncs are **resumable**: the pending queue is stored in the database, so you can press Ctrl+C
and run `npm run sync` again later. Nothing contacts the portal unless you run a sync or press
Refresh.

```bash
npm run sync -- --help                # all options
npm run sync -- --game-version 1.1    # details for 1.1 mods and newer
npm run sync -- --all                 # details for every mod (~2+ hours)
npm run sync -- --resume              # only finish the pending queue
npm run sync -- --rate 2              # be even gentler with the portal
npm run sync -- --no-embed            # skip the theme index update
npm run embed                         # update the theme index only
npm run embed -- --rebuild            # re-embed everything
```

> The mod portal API is an internal API. This tool is deliberately polite: it caches everything
> locally, throttles requests, backs off on errors, and identifies itself with a descriptive
> `User-Agent`. Please keep the default rate limit.

## Configuration

Everything has sensible defaults. To change something, copy `config.example.json` to
`config.json` or `.env.example` to `.env`. Both are git-ignored. Environment variables override
`config.json`.

| Setting                    | Env var                   | Default        | Description                                                         |
| -------------------------- | ------------------------- | -------------- | ------------------------------------------------------------------- |
| `dbPath`                   | `FMF_DB_PATH`             | `data/mods.db` | SQLite database file                                                |
| `server.host`              | `FMF_HOST`                | `127.0.0.1`    | Interface to bind (keep it local)                                   |
| `server.port`              | `FMF_PORT`                | `3000`         | HTTP port                                                           |
| `portal.requestsPerSecond` | `FMF_REQUESTS_PER_SECOND` | `3`            | Throttle for detail requests                                        |
| `portal.concurrency`       | `FMF_CONCURRENCY`         | `2`            | Parallel detail requests                                            |
| `portal.userAgent`         | `FMF_USER_AGENT`          | app name + URL | User-Agent sent to the portal                                       |
| `sync.gameVersion`         | `FMF_GAME_VERSION`        | `latest`       | Fetch details for mods targeting this version or newer              |
| `sync.staleDays`           | –                         | `0`            | Also re-fetch details older than N days (catches description edits) |
| `sync.embed`               | –                         | `true`         | Update the theme index after each sync                              |

### Theme search (embeddings)

Theme search needs an **embedding model**, which is separate from any chat LLM (Claude, for
example, has no embeddings API). By default it runs locally via
[transformers.js](https://huggingface.co/docs/transformers.js), with nothing else to install.

| Setting                                     | Env var                   | Default                                     |
| ------------------------------------------- | ------------------------- | ------------------------------------------- |
| `embeddings.provider`                       | `FMF_EMBEDDINGS_PROVIDER` | `transformers` (`ollama`, `openai`, `none`) |
| `embeddings.model`                          | `FMF_EMBEDDINGS_MODEL`    | per provider, see below                     |
| `embeddings.baseUrl`                        | `FMF_EMBEDDINGS_BASE_URL` | per provider, see below                     |
| `embeddings.apiKey`                         | `FMF_EMBEDDINGS_API_KEY`  | –                                           |
| `embeddings.cacheDir`                       | –                         | `data/models`                               |
| `embeddings.candidates`                     | –                         | `400` nearest mods before filters           |
| `embeddings.queryPrefix` / `documentPrefix` | –                         | known defaults for nomic and e5 models      |

| Provider       | Default model             | Default base URL            | Notes                                                                 |
| -------------- | ------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `transformers` | `Xenova/all-MiniLM-L6-v2` | –                           | Local, CPU, model downloaded once                                     |
| `ollama`       | `nomic-embed-text`        | `http://127.0.0.1:11434`    | Run `ollama pull nomic-embed-text` first                              |
| `openai`       | `text-embedding-3-small`  | `https://api.openai.com/v1` | Any OpenAI-compatible API: LM Studio, llama.cpp `--embeddings`, vLLM… |

Example `.env` for LM Studio:

```bash
FMF_EMBEDDINGS_PROVIDER=openai
FMF_EMBEDDINGS_BASE_URL=http://127.0.0.1:1234/v1
FMF_EMBEDDINGS_MODEL=text-embedding-nomic-embed-text-v1.5
```

Changing the provider or model rebuilds the index on the next sync or `npm run embed`. If theme
search is unavailable, the UI falls back to keyword search and says so.

## Exporting `mod-list.json`

`mod-list.json` is the file Factorio keeps in its `mods` folder to know which mods are enabled.
The export always lists `base` (the base game) as enabled. DLC (`space-age`, `quality`,
`elevated-rails`) are treated like any other mod: they are only included if they are in your list
or required by a mod in it. The file only enables mods; download them in-game (or from the
portal) as usual.

## Development

```bash
npm run dev          # API server (watch mode) + Vite dev server at http://localhost:5173
npm test             # unit tests (Vitest)
npm run check        # typecheck + lint + format check + tests
```

Project layout:

```
src/
  shared/      types, constants and the zod filter schema (used by server and UI)
  core/
    config.ts  config loading (defaults < config.json < env)
    db/        schema/migrations and connection helpers (loads sqlite-vec)
    embeddings/ embedding providers and the sqlite-vec theme index
    portal/    mod portal API client (throttling, retries, User-Agent)
    sync/      incremental, resumable sync
    deps.ts    Factorio dependency-string parser
    query.ts   filter object -> parameterized SQL
    repo.ts    search, details and facets
    lists.ts   saved mod lists
    export/    dependency resolution and txt / md / mod-list.json writers
  server/      Hono HTTP API (also serves the built UI) and on-demand detail fetching
  cli/         `npm run sync` and `npm run embed`
web/           Vite + vanilla TypeScript UI (only talks to the server over HTTP)
tests/         Vitest unit tests
```

The UI never touches the database directly. It uses the HTTP API, which keeps it easy to wrap
in Tauri or Electron later.

## Roadmap

1. ✅ Crawler + SQLite database (`npm run sync`)
2. ✅ Web UI + API: search, filters, details, saved lists, export
3. ✅ Theme search with local embeddings (transformers.js + sqlite-vec), optional Ollama / OpenAI-compatible
4. Natural-language search through a pluggable LLM (Ollama, LM Studio, llama.cpp, OpenAI-compatible
   APIs, Anthropic). The LLM only produces a validated filter object; it never reads the database.
5. Related mods (dependency graph + embeddings + shared tags), PDF export, release packaging

## License

[MIT](LICENSE). Not affiliated with Wube Software. Mod data and thumbnails belong to their
respective authors and are fetched from the official mod portal.
