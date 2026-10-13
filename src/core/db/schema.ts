/**
 * Schema migrations. Each entry is applied once, in order, tracked via PRAGMA user_version.
 * Never edit an applied migration; append a new one instead.
 */
export const MIGRATIONS: string[] = [
  /* sql */ `
  CREATE TABLE mods (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    title               TEXT NOT NULL DEFAULT '',
    owner               TEXT NOT NULL DEFAULT '',
    summary             TEXT NOT NULL DEFAULT '',
    description         TEXT NOT NULL DEFAULT '',
    category            TEXT NOT NULL DEFAULT 'no-category',
    downloads_count     INTEGER NOT NULL DEFAULT 0,
    score               REAL NOT NULL DEFAULT 0,
    created_at          TEXT,
    updated_at          TEXT,
    latest_version      TEXT,
    latest_release_at   TEXT,
    latest_sha1         TEXT,
    factorio_version    TEXT,             -- normalized "major.minor" of the latest release
    requires_space_age  INTEGER NOT NULL DEFAULT 0,
    incompatible_space_age INTEGER NOT NULL DEFAULT 0,
    deprecated          INTEGER NOT NULL DEFAULT 0,
    feature_flags       TEXT,             -- JSON array, latest release
    thumbnail           TEXT,             -- relative path, prepend portal.assetsUrl
    source_url          TEXT,
    homepage            TEXT,
    license_id          TEXT,
    license_title       TEXT,
    license_url         TEXT,
    changelog           TEXT,
    faq                 TEXT,
    last_highlighted_at TEXT,
    list_synced_at      TEXT,             -- last seen in /api/mods list
    full_synced_at      TEXT,             -- last /full fetch (NULL = details never fetched)
    removed_at          TEXT              -- no longer listed on the portal
  );
  CREATE INDEX mods_category ON mods(category);
  CREATE INDEX mods_downloads ON mods(downloads_count);
  CREATE INDEX mods_release_at ON mods(latest_release_at);
  CREATE INDEX mods_factorio_version ON mods(factorio_version);

  CREATE TABLE mod_releases (
    mod_name          TEXT NOT NULL REFERENCES mods(name) ON DELETE CASCADE,
    version           TEXT NOT NULL,
    factorio_version  TEXT,
    released_at       TEXT,
    sha1              TEXT,
    PRIMARY KEY (mod_name, version)
  ) WITHOUT ROWID;
  CREATE INDEX mod_releases_fv ON mod_releases(factorio_version, mod_name);

  CREATE TABLE mod_tags (
    mod_name  TEXT NOT NULL REFERENCES mods(name) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (mod_name, tag)
  ) WITHOUT ROWID;
  CREATE INDEX mod_tags_tag ON mod_tags(tag, mod_name);

  CREATE TABLE dependencies (
    mod_name   TEXT NOT NULL REFERENCES mods(name) ON DELETE CASCADE,
    dep_name   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('required','optional','hidden-optional','recommended','incompatible','no-load-order')),
    operator   TEXT,
    version    TEXT,
    raw        TEXT NOT NULL,
    PRIMARY KEY (mod_name, dep_name)
  ) WITHOUT ROWID;
  CREATE INDEX dependencies_dep ON dependencies(dep_name, kind);

  -- Full-text index over mods (external content: no duplicated text).
  CREATE VIRTUAL TABLE mods_fts USING fts5(
    name, title, summary, description,
    content='mods', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER mods_ai AFTER INSERT ON mods BEGIN
    INSERT INTO mods_fts(rowid, name, title, summary, description)
    VALUES (new.id, new.name, new.title, new.summary, new.description);
  END;
  CREATE TRIGGER mods_ad AFTER DELETE ON mods BEGIN
    INSERT INTO mods_fts(mods_fts, rowid, name, title, summary, description)
    VALUES ('delete', old.id, old.name, old.title, old.summary, old.description);
  END;
  CREATE TRIGGER mods_au AFTER UPDATE OF name, title, summary, description ON mods
  WHEN old.name IS NOT new.name OR old.title IS NOT new.title
    OR old.summary IS NOT new.summary OR old.description IS NOT new.description
  BEGIN
    INSERT INTO mods_fts(mods_fts, rowid, name, title, summary, description)
    VALUES ('delete', old.id, old.name, old.title, old.summary, old.description);
    INSERT INTO mods_fts(rowid, name, title, summary, description)
    VALUES (new.id, new.name, new.title, new.summary, new.description);
  END;

  -- Mods waiting for a /full fetch. Persisted so an interrupted sync can resume.
  CREATE TABLE sync_queue (
    mod_name   TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    queued_at  TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE sync_state (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  ) WITHOUT ROWID;

  -- User mod lists ("baskets"). Items may reference DLC or mods not in the DB.
  CREATE TABLE lists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE list_items (
    list_id   INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    mod_name  TEXT NOT NULL,
    added_at  TEXT NOT NULL,
    PRIMARY KEY (list_id, mod_name)
  ) WITHOUT ROWID;
  `,

  /* sql */ `
  -- sha1 of the latest release when /full details were fetched; a mismatch with
  -- latest_sha1 means the details are outdated.
  ALTER TABLE mods ADD COLUMN details_sha1 TEXT;
  UPDATE mods SET details_sha1 = latest_sha1 WHERE full_synced_at IS NOT NULL;
  `,

  /* sql */ `
  -- Which mods have a theme-search vector, and for which text. The vectors themselves
  -- live in the sqlite-vec table "vec_mods", created at runtime because its dimension
  -- depends on the embedding model.
  CREATE TABLE mod_embeddings (
    mod_id       INTEGER PRIMARY KEY REFERENCES mods(id) ON DELETE CASCADE,
    text_hash    TEXT NOT NULL,
    embedded_at  TEXT NOT NULL
  );
  `,
];
