CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  client      TEXT NOT NULL,
  file_path   TEXT,
  external_session_id TEXT,
  started_at  TEXT,
  mode        TEXT NOT NULL DEFAULT 'DEFERRED_OPAQUE'
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  server_name     TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  called_at       TEXT,
  duration_ms     INTEGER,
  is_error        INTEGER NOT NULL DEFAULT 0,
  response_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS tool_loads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  server_name TEXT,
  tool_name   TEXT NOT NULL,
  loaded_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS tool_definitions (
  server_name       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  definition_tokens INTEGER NOT NULL,
  scanned_at        TEXT NOT NULL,
  first_scanned_at  TEXT,
  PRIMARY KEY (server_name, tool_name)
);
CREATE TABLE IF NOT EXISTS client_servers (
  client      TEXT NOT NULL,
  server_name TEXT NOT NULL,
  PRIMARY KEY (client, server_name)
);
CREATE TABLE IF NOT EXISTS token_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  at            TEXT,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);
-- Incremental parse cursor: how far each file has been read (byte offset)
CREATE TABLE IF NOT EXISTS file_cursors (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_calls_tool ON tool_calls(server_name, tool_name);
CREATE INDEX IF NOT EXISTS idx_loads_session ON tool_loads(session_id);
CREATE TABLE IF NOT EXISTS ingest_observations (observation_id TEXT PRIMARY KEY, correlation_key TEXT NOT NULL, correlation_confidence TEXT NOT NULL, source TEXT NOT NULL, client TEXT NOT NULL, phase TEXT NOT NULL, external_session_id TEXT NOT NULL, external_turn_id TEXT, external_call_id TEXT, transcript_path TEXT, server_name TEXT, tool_name TEXT, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, duration_ms INTEGER, is_error INTEGER, response_tokens INTEGER, loaded_tokens INTEGER, input_fingerprint TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_delivery ON ingest_observations(observation_id);
CREATE INDEX IF NOT EXISTS idx_observation_correlation ON ingest_observations(correlation_key);
CREATE TABLE IF NOT EXISTS session_aliases (client TEXT NOT NULL, external_session_id TEXT NOT NULL, session_id TEXT NOT NULL, transcript_path TEXT, PRIMARY KEY(client, external_session_id));
CREATE TABLE IF NOT EXISTS collector_receipts (receipt_id TEXT PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, observed_at TEXT NOT NULL, error_code TEXT);

CREATE TABLE IF NOT EXISTS server_identities (
  client TEXT NOT NULL, server_name TEXT NOT NULL, source_kind TEXT NOT NULL,
  source_path_hash TEXT NOT NULL, transport TEXT NOT NULL, endpoint_hash TEXT NOT NULL,
  conflict_state TEXT NOT NULL, observed_at TEXT NOT NULL,
  PRIMARY KEY (client, server_name, source_kind, source_path_hash)
);
CREATE INDEX IF NOT EXISTS idx_server_identity_name ON server_identities(server_name);

CREATE TABLE IF NOT EXISTS tool_definition_bodies (
  server_name TEXT NOT NULL, tool_name TEXT NOT NULL, description TEXT,
  input_schema_json TEXT NOT NULL, output_schema_json TEXT,
  definition_tokens INTEGER NOT NULL,
  definition_set_hash TEXT NOT NULL, scanned_at TEXT NOT NULL,
  PRIMARY KEY (server_name, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_definition_set_hash ON tool_definition_bodies(definition_set_hash);

CREATE TABLE IF NOT EXISTS dependency_analyses (
  definition_set_hash TEXT NOT NULL, analysis_rules_version INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  analyzed_at TEXT NOT NULL, error_code TEXT,
  observed_session_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (definition_set_hash, analysis_rules_version)
);
CREATE TABLE IF NOT EXISTS tool_dependency_results (
  definition_set_hash TEXT NOT NULL, analysis_rules_version INTEGER NOT NULL,
  server_name TEXT NOT NULL, tool_name TEXT NOT NULL, status TEXT NOT NULL,
  depended_on_by_json TEXT NOT NULL, rationale TEXT NOT NULL,
  PRIMARY KEY (definition_set_hash, analysis_rules_version, server_name, tool_name)
);
CREATE TABLE IF NOT EXISTS tool_explanations (
  definition_set_hash TEXT NOT NULL, analysis_rules_version INTEGER NOT NULL,
  server_name TEXT NOT NULL, tool_name TEXT NOT NULL, display_summary TEXT NOT NULL,
  what_you_lose TEXT NOT NULL, risk_without_tool TEXT NOT NULL,
  PRIMARY KEY (definition_set_hash, analysis_rules_version, server_name, tool_name)
);

CREATE TABLE IF NOT EXISTS global_actions (
  action_id TEXT PRIMARY KEY, client TEXT NOT NULL, server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL, identity_hash TEXT NOT NULL, definition_set_hash TEXT NOT NULL,
  owned_rule TEXT NOT NULL,
  backup_path TEXT NOT NULL, pre_fingerprint TEXT NOT NULL, post_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, restored_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_global_action
  ON global_actions(client, server_name, tool_name) WHERE status='active';
CREATE TABLE IF NOT EXISTS regret_signals (
  action_id TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (action_id, kind, session_id)
);
CREATE TABLE IF NOT EXISTS inference_consents (
  policy_version INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  status TEXT NOT NULL, accepted_at TEXT NOT NULL, revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS server_scan_status (
  server_name TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  scanned_at  TEXT NOT NULL,
  error_code  TEXT
);
