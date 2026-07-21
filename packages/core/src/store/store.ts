import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterResult, ClientId, SessionMeta, ToolCallEvent, ToolDefinition,
  ToolLoadEvent } from '../types.js';
import type { ToolObservation } from '../ingest/contracts.js';
import { adapterResultToObservations } from '../ingest/log-bridge.js';
import { makeCorrelationKey } from '../ingest/identity.js';
import { deriveCollectionHealth, type CollectionHealthSnapshot } from '../health/collectionHealth.js';
import { materializeSession, sessionIdFor } from './observations.js';

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

/**
 * schema.sql은 CREATE TABLE IF NOT EXISTS라 기존 DB에는 새 컬럼이 생기지 않는다.
 * 열 때마다 실제 컬럼 목록을 보고 없으면 추가·백필한다 (멱등).
 */
function migrate(db: Database): void {
  const s = db.prepare('PRAGMA table_info(sessions)'); const sr: any[] = []; while (s.step()) sr.push(s.getAsObject()); s.free();
  if (sr.find((r) => r.name === 'file_path')?.notnull === 1) { db.exec("CREATE TABLE sessions_v2 (session_id TEXT PRIMARY KEY, client TEXT NOT NULL, file_path TEXT, external_session_id TEXT, started_at TEXT, mode TEXT NOT NULL DEFAULT 'DEFERRED_OPAQUE')"); db.exec('INSERT INTO sessions_v2(session_id,client,file_path,started_at,mode) SELECT session_id,client,file_path,started_at,mode FROM sessions'); db.exec('DROP TABLE sessions'); db.exec('ALTER TABLE sessions_v2 RENAME TO sessions'); }
  const cols = new Set<string>();
  const st = db.prepare('PRAGMA table_info(tool_definitions)');
  while (st.step()) cols.add(st.getAsObject().name as string);
  st.free();
  if (!cols.has('first_scanned_at')) {
    db.exec('ALTER TABLE tool_definitions ADD COLUMN first_scanned_at TEXT');
    db.exec('UPDATE tool_definitions SET first_scanned_at = scanned_at');
  }

}

export class StaleWriterError extends Error {
  constructor() {
    super('LensStore: writer lease lost; refusing to persist');
    this.name = 'StaleWriterError';
  }
}

export class LensStore {
  private transactionDepth = 0;
  private writeGuard: (() => boolean) | null = null;
  private constructor(private db: Database, private filePath: string, private sql: SqlJsStatic) {}
  observationCount(): number { const r = this.select('SELECT COUNT(*) AS count FROM ingest_observations', []); return Number(r[0]?.count ?? 0); }

  static async open(filePath: string): Promise<LensStore> {
    const SQL = await initSqlJs();
    const db = filePath !== ':memory:' && existsSync(filePath)
      ? new SQL.Database(readFileSync(filePath))
      : new SQL.Database();
    db.exec(SCHEMA);
    migrate(db);
    return new LensStore(db, filePath, SQL);
  }

  setWriteGuard(fn: (() => boolean) | null): void {
    this.writeGuard = fn;
  }

  reload(): void {
    if (this.filePath === ':memory:' || !existsSync(this.filePath)) return;
    this.db.close();
    this.db = new this.sql.Database(readFileSync(this.filePath));
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  ingest(r: AdapterResult): void {
    this.transaction(() => {
      const { session: s } = r;
      const externalSessionId = s.externalSessionId ?? s.sessionId;
      if (externalSessionId !== s.sessionId) {
        this.promoteFallbackAlias(s.client, s.sessionId, externalSessionId, s.sessionId);
      }
      const prior = this.aliasSessionId(s.client, externalSessionId);
      this.run(
        `INSERT INTO sessions(session_id, client, file_path, external_session_id, started_at, mode)
         VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
           client=excluded.client, file_path=excluded.file_path,
           external_session_id=excluded.external_session_id, started_at=excluded.started_at,
           mode=excluded.mode`,
        [s.sessionId, s.client, s.filePath, externalSessionId, s.startedAt, s.mode]);
      this.run(
        `INSERT INTO session_aliases(client, external_session_id, session_id, transcript_path)
         VALUES(?,?,?,?) ON CONFLICT(client, external_session_id) DO UPDATE SET
           session_id=excluded.session_id, transcript_path=excluded.transcript_path`,
        [s.client, externalSessionId, s.sessionId, s.filePath]);
      this.run(
        `DELETE FROM ingest_observations
         WHERE source='log' AND client=? AND external_session_id=?`,
        [s.client, externalSessionId]);
      for (const [index, observation] of adapterResultToObservations(r, []).entries()) {
        // A hook and its transcript record can share native identity. Delivery
        // idempotency is source-local, while the ordinal preserves occurrences
        // whose fallback correlation identities are intentionally identical.
        this.insertObservation({
          ...observation,
          deliveryId: `log:${index}:${observation.deliveryId}`,
        });
      }
      this.rebuildSession(s.sessionId);
      if (prior !== null && prior !== s.sessionId) this.refreshDisplacedSession(prior);
      this.run('DELETE FROM token_usage WHERE session_id = ?', [s.sessionId]);
      for (const u of r.usage)
        this.run(
          `INSERT INTO token_usage(session_id, at, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens) VALUES(?,?,?,?,?,?)`,
          [u.sessionId, u.at, u.inputTokens, u.outputTokens,
           u.cacheReadTokens, u.cacheCreationTokens]);
    });
  }

  begin(): void {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      return;
    }
    this.db.exec('BEGIN');
    this.transactionDepth = 1;
  }
  commit(): void {
    if (this.transactionDepth === 0) throw new Error('No transaction to commit');
    if (this.transactionDepth > 1) {
      this.transactionDepth -= 1;
      return;
    }
    this.db.exec('COMMIT');
    this.transactionDepth = 0;
    this.save();
  }
  rollback(): void {
    if (this.transactionDepth === 0) throw new Error('No transaction to roll back');
    this.db.exec('ROLLBACK');
    this.transactionDepth = 0;
  }

  upsertObservation(observation: ToolObservation): void {
    this.transaction(() => {
      this.insertObservation(observation);
      this.rebuildSession(this.ensureAlias(observation));
    });
  }

  observationsForSession(sessionId: string): ToolObservation[] {
    return this.select(
      `SELECT o.* FROM ingest_observations o JOIN session_aliases a
       ON a.client=o.client AND a.external_session_id=o.external_session_id
       WHERE a.session_id=? ORDER BY o.observed_at, o.observation_id`, [sessionId],
    ).map(rowToObservation);
  }

  recordReceipt(receipt: CollectorReceipt): void {
    this.run(
      `INSERT INTO collector_receipts(receipt_id, client, kind, status, observed_at, error_code)
       VALUES(?,?,?,?,?,?) ON CONFLICT(receipt_id) DO NOTHING`,
      [receipt.receiptId, receipt.client, receipt.kind, receipt.status, receipt.observedAt, receipt.errorCode],
    );
  }

  collectionHealth(now = new Date().toISOString()): CollectionHealthSnapshot {
    const observations = this.select(
      'SELECT source, phase, correlation_key, observed_at FROM ingest_observations ORDER BY observed_at, observation_id', [],
    ).map((row) => ({
      source: row.source as 'hook' | 'log', phase: row.phase as ToolObservation['phase'],
      correlationKey: row.correlation_key as string, observedAt: row.observed_at as string,
    }));
    return deriveCollectionHealth({ now, observations });
  }

  collectionHealthByClient(now = new Date().toISOString()): Map<ClientId, CollectionHealthSnapshot> {
    const rows = this.select(
      'SELECT client, source, phase, correlation_key, observed_at FROM ingest_observations ORDER BY observed_at, observation_id', [],
    );
    const byClient = new Map<ClientId, {
      source: 'hook' | 'log'; phase: ToolObservation['phase'];
      correlationKey: string; observedAt: string;
    }[]>();
    for (const row of rows) {
      const client = row.client as ClientId;
      const list = byClient.get(client) ?? [];
      list.push({
        source: row.source as 'hook' | 'log', phase: row.phase as ToolObservation['phase'],
        correlationKey: row.correlation_key as string, observedAt: row.observed_at as string,
      });
      byClient.set(client, list);
    }
    const result = new Map<ClientId, CollectionHealthSnapshot>();
    for (const [client, observations] of byClient) {
      result.set(client, deriveCollectionHealth({ now, observations }));
    }
    return result;
  }

  upsertDefinitions(defs: ToolDefinition[]): void {
    this.transaction(() => {
      for (const d of defs)
        this.run(
          `INSERT INTO tool_definitions(server_name, tool_name, definition_tokens,
             scanned_at, first_scanned_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(server_name, tool_name) DO UPDATE
             SET definition_tokens=excluded.definition_tokens,
                 scanned_at=excluded.scanned_at,
                 first_scanned_at=COALESCE(tool_definitions.first_scanned_at,
                                           excluded.first_scanned_at)`,
          [d.serverName, d.toolName, d.definitionTokens, d.scannedAt, d.firstScannedAt]);
    });
  }

  getCursor(filePath: string): { byteOffset: number; mtimeMs: number } | null {
    const rows = this.select(
      'SELECT byte_offset, mtime_ms FROM file_cursors WHERE file_path=?', [filePath]);
    return rows.length
      ? { byteOffset: rows[0].byte_offset as number, mtimeMs: rows[0].mtime_ms as number }
      : null;
  }
  setCursor(filePath: string, byteOffset: number, mtimeMs: number): void {
    this.run(
      `INSERT INTO file_cursors(file_path, byte_offset, mtime_ms) VALUES(?,?,?)
       ON CONFLICT(file_path) DO UPDATE SET byte_offset=excluded.byte_offset, mtime_ms=excluded.mtime_ms`,
      [filePath, byteOffset, mtimeMs]);
  }

  allDefinitions(): ToolDefinition[] {
    return this.select('SELECT * FROM tool_definitions', []).map((r) => ({
      serverName: r.server_name as string, toolName: r.tool_name as string,
      definitionTokens: r.definition_tokens as number, scannedAt: r.scanned_at as string,
      // 마이그레이션 직후·구행 방어: 값이 없으면 scanned_at을 최초 관찰로 간주
      firstScannedAt: (r.first_scanned_at as string | null) ?? (r.scanned_at as string),
    }));
  }

  /**
   * 서버 귀속을 저장한다. replaceable에 든 클라이언트만 행을 통째로 교체하고,
   * 그 외 클라이언트(설정 읽기 실패)는 기존 매핑을 보존한다.
   */
  upsertClientServers(attribution: Map<string, Set<ClientId>>,
    replaceable: Set<ClientId>): void {
    for (const client of replaceable)
      this.run('DELETE FROM client_servers WHERE client=?', [client]);
    for (const [serverName, clients] of attribution)
      for (const client of clients) {
        if (!replaceable.has(client)) continue; // 보존 대상은 새로 쓰지도 않는다
        this.run(
          `INSERT INTO client_servers(client, server_name) VALUES(?,?)
           ON CONFLICT(client, server_name) DO NOTHING`,
          [client, serverName]);
      }
  }

  /** 클라이언트 → 그 클라이언트에 설정된 서버 이름 집합. 매핑이 없으면 빈 맵. */
  serversByClient(): Map<ClientId, Set<string>> {
    const out = new Map<ClientId, Set<string>>();
    for (const r of this.select('SELECT client, server_name FROM client_servers', [])) {
      const client = r.client as ClientId;
      let set = out.get(client);
      if (set === undefined) { set = new Set(); out.set(client, set); }
      set.add(r.server_name as string);
    }
    return out;
  }

  callsSince(iso: string): ToolCallEvent[] {
    return this.select(
      `SELECT * FROM tool_calls WHERE called_at IS NULL OR called_at >= ?`, [iso]
    ).map((r) => ({
      sessionId: r.session_id as string, serverName: r.server_name as string,
      toolName: r.tool_name as string, calledAt: r.called_at as string | null,
      durationMs: r.duration_ms as number | null, isError: r.is_error === 1,
      responseTokens: r.response_tokens as number | null, responseText: null,
    }));
  }
  loadsSince(iso: string): ToolLoadEvent[] {
    return this.select(
      `SELECT l.* FROM tool_loads l
       JOIN sessions s ON s.session_id = l.session_id
       WHERE s.started_at IS NULL OR s.started_at >= ?`, [iso]
    ).map((r) => ({
      sessionId: r.session_id as string, serverName: r.server_name as string | null,
      toolName: r.tool_name as string, loadedTokens: r.loaded_tokens as number | null,
    }));
  }
  sessionsSince(iso: string): SessionMeta[] {
    return this.select(
      `SELECT * FROM sessions WHERE started_at IS NULL OR started_at >= ?`, [iso]
    ).map((r) => ({
      sessionId: r.session_id as string, client: r.client as SessionMeta['client'],
      filePath: r.file_path as string | null, externalSessionId: r.external_session_id as string | null, startedAt: r.started_at as string | null,
      mode: r.mode as SessionMeta['mode'],
    }));
  }

  /**
   * 전 기간 기준 툴별 마지막 호출 시각. 키는 `${serverName} ${toolName}`.
   * 분석 창(callsSince) 밖의 과거 사용 이력을 확신 등급에 반영하기 위한 것 —
   * 창 안 호출만 보면 "예전엔 쓰던 툴"과 "한 번도 안 쓴 툴"이 구분되지 않는다.
   */
  lastCallByTool(): Map<string, string> {
    const rows = this.select(
      `SELECT server_name, tool_name, MAX(called_at) AS last_called_at
       FROM tool_calls WHERE called_at IS NOT NULL
       GROUP BY server_name, tool_name`, []);
    return new Map(rows.map((r) => [
      `${r.server_name as string} ${r.tool_name as string}`,
      r.last_called_at as string,
    ]));
  }

  save(): void {
    if (this.filePath === ':memory:') return;
    if (this.writeGuard && !this.writeGuard()) throw new StaleWriterError();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, Buffer.from(this.db.export()));
    renameSync(tmp, this.filePath); // 원자적 교체
  }
  close(): void { this.db.close(); }

  private transaction(action: () => void): void {
    const outer = this.transactionDepth === 0;
    if (outer) this.begin();
    try { action(); if (outer) this.commit(); }
    catch (error) { if (outer && this.transactionDepth > 0) this.rollback(); throw error; }
  }
  private insertObservation(observation: ToolObservation): void {
    this.run(
      `INSERT INTO ingest_observations(observation_id, correlation_key, correlation_confidence,
       source, client, phase, external_session_id, external_turn_id, external_call_id,
       transcript_path, server_name, tool_name, observed_at, received_at, duration_ms,
       is_error, response_tokens, loaded_tokens, input_fingerprint)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(observation_id) DO NOTHING`,
      [observation.deliveryId, observation.correlationKey, observation.correlationConfidence,
        observation.source, observation.client, observation.phase, observation.externalSessionId,
        observation.externalTurnId, observation.externalCallId, observation.transcriptPath,
        observation.serverName, observation.toolName, observation.observedAt, observation.receivedAt,
        observation.durationMs, observation.isError === null ? null : Number(observation.isError),
        observation.responseTokens, observation.loadedTokens, observation.inputFingerprint],
    );
  }
  private ensureAlias(observation: ToolObservation): string {
    const existing = this.aliasSessionId(observation.client, observation.externalSessionId);
    if (existing !== null) return existing;
    const legacySessionId = observation.transcriptPath === null
      ? null
      : this.sessionIdByTranscriptPath(observation.client, observation.transcriptPath);
    const sessionId = legacySessionId ?? sessionIdFor(observation);
    if (legacySessionId !== null) {
      this.backfillLegacyObservations(legacySessionId, observation);
    }
    this.run(
      `INSERT INTO session_aliases(client, external_session_id, session_id, transcript_path)
       VALUES(?,?,?,?)`, [observation.client, observation.externalSessionId, sessionId, observation.transcriptPath]);
    return sessionId;
  }
  private aliasSessionId(client: string, externalSessionId: string): string | null {
    const row = this.select('SELECT session_id FROM session_aliases WHERE client=? AND external_session_id=?', [client, externalSessionId])[0];
    return (row?.session_id as string | undefined) ?? null;
  }
  private sessionIdByTranscriptPath(
    client: ToolObservation['client'],
    transcriptPath: string,
  ): string | null {
    const row = this.select(
      `SELECT session_id FROM sessions
       WHERE client=? AND file_path=? ORDER BY session_id LIMIT 1`,
      [client, transcriptPath],
    )[0];
    return (row?.session_id as string | undefined) ?? null;
  }
  private backfillLegacyObservations(
    sessionId: string,
    observation: ToolObservation,
  ): void {
    const existingObservation = this.select(
      `SELECT 1 FROM ingest_observations o JOIN session_aliases a
       ON a.client=o.client AND a.external_session_id=o.external_session_id
       WHERE a.session_id=? LIMIT 1`,
      [sessionId],
    )[0];
    if (existingObservation !== undefined) return;

    const session = this.select('SELECT * FROM sessions WHERE session_id=?', [sessionId])[0];
    if (session === undefined) return;
    const legacy: AdapterResult = {
      session: {
        sessionId,
        client: session.client as SessionMeta['client'],
        filePath: session.file_path as string | null,
        externalSessionId: observation.externalSessionId,
        startedAt: session.started_at as string | null,
        mode: session.mode as SessionMeta['mode'],
      },
      toolCalls: this.select(
        'SELECT * FROM tool_calls WHERE session_id=? ORDER BY id',
        [sessionId],
      ).map((call) => ({
        sessionId,
        serverName: call.server_name as string,
        toolName: call.tool_name as string,
        calledAt: call.called_at as string | null,
        durationMs: call.duration_ms as number | null,
        isError: call.is_error === 1,
        responseTokens: call.response_tokens as number | null,
        responseText: null,
        externalCallId: null,
      })),
      toolLoads: this.select(
        'SELECT * FROM tool_loads WHERE session_id=? ORDER BY id',
        [sessionId],
      ).map((load) => ({
        sessionId,
        serverName: load.server_name as string | null,
        toolName: load.tool_name as string,
        loadedTokens: load.loaded_tokens as number | null,
      })),
      usage: [],
      parseErrors: 0,
    };
    for (const [index, logObservation] of adapterResultToObservations(legacy, []).entries()) {
      this.insertObservation({
        ...logObservation,
        deliveryId: `log:${index}:legacy:${logObservation.deliveryId}`,
      });
    }
  }
  private promoteFallbackAlias(
    client: ToolObservation['client'],
    fallbackExternalSessionId: string,
    nativeExternalSessionId: string,
    sessionId: string,
  ): void {
    if (this.aliasSessionId(client, fallbackExternalSessionId) !== sessionId) return;
    const hooks = this.select(
      `SELECT * FROM ingest_observations
       WHERE source='hook' AND client=? AND external_session_id=?`,
      [client, fallbackExternalSessionId],
    ).map(rowToObservation);
    for (const hook of hooks) {
      const promoted = { ...hook, externalSessionId: nativeExternalSessionId };
      this.run(
        `UPDATE ingest_observations
         SET external_session_id=?, correlation_key=?
         WHERE observation_id=?`,
        [nativeExternalSessionId, makeCorrelationKey(promoted), hook.deliveryId],
      );
    }
    this.run(
      `DELETE FROM ingest_observations
       WHERE source='log' AND client=? AND external_session_id=?`,
      [client, fallbackExternalSessionId],
    );
    this.run(
      `DELETE FROM session_aliases
       WHERE client=? AND external_session_id=? AND session_id=?`,
      [client, fallbackExternalSessionId, sessionId],
    );
  }
  private rebuildSession(sessionId: string): void {
    const observations = this.observationsForSession(sessionId);
    for (const table of ['tool_calls', 'tool_loads']) {
      this.run(`DELETE FROM ${table} WHERE session_id=?`, [sessionId]);
    }
    if (observations.length === 0) return;
    const materialized = materializeSession(observations);
    const session = materialized.session;
    this.run(
      `INSERT INTO sessions(session_id, client, file_path, external_session_id, started_at, mode)
       VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET client=excluded.client,
       file_path=excluded.file_path, external_session_id=excluded.external_session_id,
       started_at=excluded.started_at`,
      [sessionId, session.client, session.filePath, session.externalSessionId, session.startedAt, session.mode]);
    for (const call of materialized.toolCalls) this.run(
      `INSERT INTO tool_calls(session_id, server_name, tool_name, called_at, duration_ms, is_error, response_tokens)
       VALUES(?,?,?,?,?,?,?)`, [sessionId, call.serverName, call.toolName, call.calledAt,
        call.durationMs, Number(call.isError), call.responseTokens]);
    for (const load of materialized.toolLoads) this.run(
      `INSERT INTO tool_loads(session_id, server_name, tool_name, loaded_tokens) VALUES(?,?,?,?)`,
      [sessionId, load.serverName, load.toolName, load.loadedTokens]);
  }
  private refreshDisplacedSession(sessionId: string): void {
    const aliases = this.select(
      'SELECT COUNT(*) AS count FROM session_aliases WHERE session_id=?',
      [sessionId],
    );
    if (Number(aliases[0]?.count ?? 0) > 0) this.rebuildSession(sessionId);
    else this.deleteCanonicalSession(sessionId);
  }
  private deleteCanonicalSession(sessionId: string): void {
    const aliases = this.select(
      'SELECT COUNT(*) AS count FROM session_aliases WHERE session_id=?',
      [sessionId],
    );
    if (Number(aliases[0]?.count ?? 0) > 0) return;
    for (const table of ['tool_calls', 'tool_loads', 'token_usage']) this.run(`DELETE FROM ${table} WHERE session_id=?`, [sessionId]);
    this.run('DELETE FROM sessions WHERE session_id=?', [sessionId]);
  }

  private run(sql: string, params: unknown[]): void {
    const st = this.db.prepare(sql); st.run(params as any); st.free();
  }
  private select(sql: string, params: unknown[]): Record<string, unknown>[] {
    const st = this.db.prepare(sql); st.bind(params as any);
    const out: Record<string, unknown>[] = [];
    while (st.step()) out.push(st.getAsObject());
    st.free(); return out;
  }
}

export interface CollectorReceipt {
  receiptId: string;
  client: ToolObservation['client'];
  kind: string;
  status: string;
  observedAt: string;
  errorCode: string | null;
}

function rowToObservation(row: Record<string, unknown>): ToolObservation {
  return {
    schemaVersion: 1, deliveryId: row.observation_id as string,
    correlationKey: row.correlation_key as string,
    correlationConfidence: row.correlation_confidence as ToolObservation['correlationConfidence'],
    source: row.source as ToolObservation['source'], client: row.client as ToolObservation['client'],
    phase: row.phase as ToolObservation['phase'], externalSessionId: row.external_session_id as string,
    externalTurnId: row.external_turn_id as string | null, externalCallId: row.external_call_id as string | null,
    transcriptPath: row.transcript_path as string | null, serverName: row.server_name as string | null,
    toolName: row.tool_name as string | null, observedAt: row.observed_at as string,
    receivedAt: row.received_at as string, durationMs: row.duration_ms as number | null,
    isError: row.is_error === null ? null : row.is_error === 1,
    inputFingerprint: row.input_fingerprint as string | null,
    responseTokens: row.response_tokens as number | null, loadedTokens: row.loaded_tokens as number | null,
  };
}
