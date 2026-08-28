CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  app_slug TEXT NOT NULL,
  version_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  UNIQUE(app_slug, version_id, plan_hash)
);

CREATE TABLE assets (
  asset_identity TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  position INTEGER NOT NULL,
  eagle_item_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  descriptor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE screen_hashes (
  screen_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  descriptor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE run_assets (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  asset_identity TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, asset_identity)
);

CREATE TABLE managed_folders (
  logical_key TEXT PRIMARY KEY,
  eagle_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  parent_key TEXT,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE eagle_cache (
  eagle_item_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  sha256 TEXT,
  size INTEGER,
  mtime_ms REAL,
  folders_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE migration_checkpoints (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
