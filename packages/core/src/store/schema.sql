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
-- 증분 파싱 커서: 파일별로 어디까지 읽었나 (바이트 오프셋)
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
