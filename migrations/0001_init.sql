-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only (prefix la_); `tb_*` names are reserved for the SDK. Design: leads/live-artifacts/DESIGN.md §4.1.
CREATE TABLE la_artifact (
  id TEXT PRIMARY KEY,                      -- art_<ULID>
  gallery_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  live_version INTEGER NOT NULL,
  staged_version INTEGER,
  staged_title TEXT,                        -- title/description waiting for the owner on a shared page
  staged_description TEXT,
  auto_publish TEXT NOT NULL DEFAULT 'owner' CHECK (auto_publish IN ('owner', 'agent')),
  refresh_every_s INTEGER,                  -- the schedule in force: the owner's value once approved, else the proposal
  refresh_proposed_s INTEGER,               -- what the agent's contract proposes (an agent change is compared with this)
  refresh_approved INTEGER NOT NULL DEFAULT 0,
  refresh_state TEXT NOT NULL DEFAULT 'off' CHECK (refresh_state IN ('off', 'waiting_approval', 'on', 'paused', 'paused_error')),
  next_refresh_at INTEGER,
  lease_until INTEGER,
  last_refresh_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  refresh_job_id TEXT,                      -- the SDK job (kind refresh) that runs the approved schedule
  manual_refresh_at INTEGER,                -- last agent artifact_refresh (rate limit)
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  origin_kind TEXT NOT NULL DEFAULT 'agent',
  origin_ref TEXT,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX la_artifact_by_gallery ON la_artifact (gallery_id, updated_at DESC, id DESC);
CREATE INDEX la_artifact_due ON la_artifact (refresh_state, next_refresh_at);

CREATE TABLE la_version (
  artifact_id TEXT NOT NULL REFERENCES la_artifact (id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  html BLOB NOT NULL,
  html_sha256 TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, n)
);

CREATE TABLE la_source (
  artifact_id TEXT NOT NULL REFERENCES la_artifact (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('push', 'read')),
  label TEXT NOT NULL DEFAULT '',
  product TEXT,
  op TEXT,
  input_json TEXT,
  projection_json TEXT,
  digest TEXT NOT NULL,                     -- sha256 of JCS {product, op, input, projection}
  approved_digest TEXT,
  approved_by TEXT,
  approved_at INTEGER,
  viewers INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_id, key)
);

CREATE TABLE la_snapshot (
  artifact_id TEXT NOT NULL REFERENCES la_artifact (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  data_json TEXT,                           -- last good value, kept on failure
  staged_json TEXT,                         -- pushed data waiting for the owner (shared page, auto_publish = owner)
  bytes INTEGER NOT NULL DEFAULT 0,
  digest TEXT,
  fetched_at INTEGER,
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'ok', 'held', 'error', 'paused', 'not_approved')),
  code TEXT,
  pushed_by_id TEXT,
  pushed_by_name TEXT,
  hold_key TEXT,                            -- idempotency key of a held read, reused until the hold is decided
  PRIMARY KEY (artifact_id, key)
);

CREATE TABLE la_link (
  id TEXT PRIMARY KEY,                      -- lnk_<ULID>
  artifact_id TEXT NOT NULL REFERENCES la_artifact (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('viewer', 'preview')),
  token_digest TEXT NOT NULL UNIQUE,        -- sha256 of the token; the token itself is never stored
  label TEXT NOT NULL DEFAULT '',
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  pin_version INTEGER,
  last_seen_day TEXT,
  views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX la_link_by_artifact ON la_link (artifact_id, kind);

CREATE TABLE la_view_day (
  link_id TEXT NOT NULL REFERENCES la_link (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, day)
);

CREATE TABLE la_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE la_activity (
  id TEXT PRIMARY KEY,                      -- act_<ULID>
  artifact_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  by_type TEXT NOT NULL,
  by_id TEXT NOT NULL,
  by_name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX la_activity_by_artifact ON la_activity (artifact_id, at DESC);
