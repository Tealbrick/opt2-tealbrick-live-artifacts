-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only; `tb_*` names are reserved for the SDK.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX items_by_collection ON items (collection, created_at DESC, id DESC);
