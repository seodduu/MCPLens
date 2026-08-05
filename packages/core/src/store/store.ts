import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdapterResult, ClientId, DependencyAnalysis, DependencyCallRecord, GlobalAction,
  GlobalActionClient, GlobalActionStatus, InferenceConsent, RegretSignal, ServerIdentity,
  SessionMeta, ToolCallEvent, ToolDefinition, ToolDefinitionBody, ToolLoadEvent,
} from '../types.js';
import type { ToolObservation } from '../ingest/contracts.js';
import { adapterResultToObservations } from '../ingest/log-bridge.js';
import { makeCorrelationKey } from '../ingest/identity.js';
import { deriveCollectionHealth, type CollectionHealthSnapshot } from '../health/collectionHealth.js';
import { directClaudeRegretSignals } from '../regret/claudeAttempt.js';
import { materializeSession, sessionIdFor } from './observations.js';

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

export type ServerScanStatusKind = 'ok' | 'auth-required' | 'failed';

export interface ServerScanStatus {
  status: ServerScanStatusKind;
  scannedAt: string;
  errorCode?: string;
}

function atOrAfter(observedAt: string, createdAt: string): boolean {
  const observed = Date.parse(observedAt);
  const created = Date.parse(createdAt);
  return Number.isFinite(observed) && Number.isFinite(created) && observed >= created;
}

/**
 * schema.sql uses CREATE TABLE IF NOT EXISTS, so new columns never appear on an existing DB.
 * On every open the real column list is inspected and missing columns are added and backfilled (idempotent).
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
        for (const signal of directClaudeRegretSignals(this.activeActions(), observation)) {
          this.recordRegretSignal(signal);
        }
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
      for (const attempt of r.toolSearchAttempts ?? []) {
        for (const action of this.activeActions()) {
          if (
            action.client === 'codex'
            && attempt.exactToolName === `mcp__${action.serverName}__${action.toolName}`
            && atOrAfter(attempt.observedAt, action.createdAt)
          ) {
            this.recordRegretSignal({
              actionId: action.actionId,
              kind: 'indirect',
              sessionId: attempt.sessionId,
              observedAt: attempt.observedAt,
            });
          }
        }
      }
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
      for (const signal of directClaudeRegretSignals(this.activeActions(), observation)) {
        this.recordRegretSignal(signal);
      }
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

  upsertDefinitions(defs: readonly ToolDefinition[]): void {
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
      this.reattributePendingCodexLoads();
    });
  }

  upsertServerIdentities(rows: readonly ServerIdentity[]): void {
    this.transaction(() => {
      for (const row of rows) this.run(
        `INSERT INTO server_identities(client, server_name, source_kind, source_path_hash,
           transport, endpoint_hash, conflict_state, observed_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(client, server_name, source_kind, source_path_hash)
         DO UPDATE SET transport=excluded.transport, endpoint_hash=excluded.endpoint_hash,
           conflict_state=excluded.conflict_state, observed_at=excluded.observed_at`,
        [row.client, row.serverName, row.sourceKind, row.sourcePathHash, row.transport,
          row.endpointHash, row.conflictState, row.observedAt],
      );
    });
  }

  serverIdentities(serverName?: string): ServerIdentity[] {
    const rows = serverName === undefined
      ? this.select(`SELECT * FROM server_identities
          ORDER BY server_name, client, source_kind, source_path_hash`, [])
      : this.select(`SELECT * FROM server_identities WHERE server_name=?
          ORDER BY client, source_kind, source_path_hash`, [serverName]);
    return rows.map(rowToServerIdentity);
  }

  upsertDefinitionBodies(rows: readonly ToolDefinitionBody[]): void {
    this.transaction(() => {
      for (const row of rows) this.run(
        `INSERT INTO tool_definition_bodies(server_name, tool_name, description,
           input_schema_json, definition_tokens, definition_set_hash, scanned_at)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(server_name, tool_name) DO UPDATE SET
           description=excluded.description, input_schema_json=excluded.input_schema_json,
           definition_tokens=excluded.definition_tokens,
           definition_set_hash=excluded.definition_set_hash, scanned_at=excluded.scanned_at`,
        [row.serverName, row.toolName, row.description, row.inputSchemaJson,
          row.definitionTokens, row.definitionSetHash, row.scannedAt],
      );
    });
  }

  upsertScanResult(
    definitions: readonly ToolDefinition[],
    bodies: readonly ToolDefinitionBody[],
    identities: readonly ServerIdentity[],
  ): void {
    this.transaction(() => {
      this.upsertDefinitions(definitions);
      this.upsertDefinitionBodies(bodies);
      this.upsertServerIdentities(identities);
    });
  }

  definitionBodiesForServer(serverName: string): ToolDefinitionBody[] {
    return this.select(
      `SELECT * FROM tool_definition_bodies WHERE server_name=? ORDER BY tool_name`,
      [serverName],
    ).map(rowToDefinitionBody);
  }

  dependencyCallsSince(iso: string): DependencyCallRecord[] {
    return this.select(
      `SELECT id, session_id, server_name, tool_name, called_at, is_error
       FROM tool_calls WHERE called_at IS NULL OR called_at >= ?
       ORDER BY session_id, called_at, id`,
      [iso],
    ).map((row) => ({
      sequence: row.id as number,
      sessionId: row.session_id as string,
      serverName: row.server_name as string,
      toolName: row.tool_name as string,
      calledAt: row.called_at as string | null,
      isError: row.is_error === 1,
    }));
  }

  findDependencyAnalysis(
    definitionSetHash: string,
    rulesVersion: number,
  ): DependencyAnalysis | null {
    const row = this.select(
      `SELECT * FROM dependency_analyses
       WHERE definition_set_hash=? AND analysis_rules_version=?`,
      [definitionSetHash, rulesVersion],
    )[0];
    if (row === undefined) return null;
    const results = this.select(
      `SELECT r.*, e.display_summary, e.what_you_lose, e.risk_without_tool
       FROM tool_dependency_results r LEFT JOIN tool_explanations e
       ON e.definition_set_hash=r.definition_set_hash
         AND e.analysis_rules_version=r.analysis_rules_version
         AND e.server_name=r.server_name AND e.tool_name=r.tool_name
       WHERE r.definition_set_hash=? AND r.analysis_rules_version=?
       ORDER BY r.server_name, r.tool_name`,
      [definitionSetHash, rulesVersion],
    ).map((result) => ({
      serverName: result.server_name as string,
      toolName: result.tool_name as string,
      status: result.status as DependencyAnalysis['results'][number]['status'],
      dependedOnBy: JSON.parse(result.depended_on_by_json as string) as string[],
      rationale: result.rationale as string,
      displaySummary: result.display_summary as string | null,
      whatYouLose: result.what_you_lose as string | null,
      riskWithoutTool: result.risk_without_tool as string | null,
    }));
    return {
      definitionSetHash: row.definition_set_hash as string,
      analysisRulesVersion: row.analysis_rules_version as number,
      provider: row.provider as DependencyAnalysis['provider'],
      model: row.model as string,
      status: row.status as DependencyAnalysis['status'],
      analyzedAt: row.analyzed_at as string,
      errorCode: row.error_code as string | null,
      results,
    };
  }

  saveDependencyAnalysis(analysis: DependencyAnalysis): void {
    this.transaction(() => {
      const key = [analysis.definitionSetHash, analysis.analysisRulesVersion];
      this.run(
        `INSERT INTO dependency_analyses(definition_set_hash, analysis_rules_version,
           provider, model, status, analyzed_at, error_code) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(definition_set_hash, analysis_rules_version) DO UPDATE SET
           provider=excluded.provider, model=excluded.model, status=excluded.status,
           analyzed_at=excluded.analyzed_at, error_code=excluded.error_code`,
        [...key, analysis.provider, analysis.model, analysis.status,
          analysis.analyzedAt, analysis.errorCode],
      );
      this.run(
        `DELETE FROM tool_explanations
         WHERE definition_set_hash=? AND analysis_rules_version=?`, key,
      );
      this.run(
        `DELETE FROM tool_dependency_results
         WHERE definition_set_hash=? AND analysis_rules_version=?`, key,
      );
      for (const result of analysis.results) {
        this.run(
          `INSERT INTO tool_dependency_results(definition_set_hash, analysis_rules_version,
             server_name, tool_name, status, depended_on_by_json, rationale)
           VALUES(?,?,?,?,?,?,?)`,
          [...key, result.serverName, result.toolName, result.status,
            JSON.stringify(result.dependedOnBy), result.rationale],
        );
        const explanation = [result.displaySummary, result.whatYouLose, result.riskWithoutTool];
        if (explanation.every((value) => value !== null)) this.run(
          `INSERT INTO tool_explanations(definition_set_hash, analysis_rules_version,
             server_name, tool_name, display_summary, what_you_lose, risk_without_tool)
           VALUES(?,?,?,?,?,?,?)`,
          [...key, result.serverName, result.toolName, ...explanation],
        );
      }
    });
  }

  recordGlobalAction(action: GlobalAction): void {
    this.transaction(() => this.run(
      `INSERT INTO global_actions(action_id, client, server_name, tool_name, identity_hash,
       definition_set_hash, owned_rule, backup_path, pre_fingerprint, post_fingerprint,
       status, created_at, restored_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [action.actionId, action.client, action.serverName, action.toolName,
        action.identityHash, action.definitionSetHash, action.ownedRule, action.backupPath,
        action.preFingerprint, action.postFingerprint, action.status, action.createdAt,
        action.restoredAt],
    ));
  }

  activeActionFor(
    client: GlobalActionClient,
    serverName: string,
    toolName: string,
  ): GlobalAction | null {
    const row = this.select(
      `SELECT * FROM global_actions
       WHERE client=? AND server_name=? AND tool_name=? AND status='active'`,
      [client, serverName, toolName],
    )[0];
    return row === undefined ? null : rowToGlobalAction(row);
  }

  activeActions(): GlobalAction[] {
    return this.select(
      `SELECT * FROM global_actions WHERE status='active'
       ORDER BY client, server_name, tool_name, action_id`, [],
    ).map(rowToGlobalAction);
  }

  /** Reports whether this exact definition was restored after the reference time the caller gave. */
  hasRestoredActionSince(
    client: GlobalActionClient,
    serverName: string,
    toolName: string,
    definitionSetHash: string,
    sinceIso: string,
  ): boolean {
    return this.select(
      `SELECT 1 FROM global_actions
       WHERE client=? AND server_name=? AND tool_name=? AND definition_set_hash=?
         AND status='restored' AND restored_at IS NOT NULL AND restored_at >= ?
       LIMIT 1`,
      [client, serverName, toolName, definitionSetHash, sinceIso],
    ).length > 0;
  }

  updateGlobalActionStatus(
    actionId: string,
    status: GlobalActionStatus,
    restoredAt?: string,
  ): void {
    this.transaction(() => this.run(
      `UPDATE global_actions SET status=?, restored_at=? WHERE action_id=?`,
      [status, restoredAt ?? null, actionId],
    ));
  }

  recordRegretSignal(signal: RegretSignal): void {
    this.transaction(() => this.run(
      `INSERT INTO regret_signals(action_id, kind, session_id, observed_at)
       VALUES(?,?,?,?) ON CONFLICT(action_id, kind, session_id) DO NOTHING`,
      [signal.actionId, signal.kind, signal.sessionId, signal.observedAt],
    ));
  }

  regretSignals(actionId: string): RegretSignal[] {
    return this.select(
      `SELECT * FROM regret_signals WHERE action_id=? ORDER BY observed_at, kind, session_id`,
      [actionId],
    ).map((row) => ({
      actionId: row.action_id as string,
      kind: row.kind as RegretSignal['kind'],
      sessionId: row.session_id as string,
      observedAt: row.observed_at as string,
    }));
  }

  saveInferenceConsent(consent: InferenceConsent): void {
    this.transaction(() => this.run(
      `INSERT INTO inference_consents(policy_version, provider, model, status, accepted_at,
       revoked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(policy_version) DO UPDATE SET
       provider=excluded.provider, model=excluded.model, status=excluded.status,
       accepted_at=excluded.accepted_at, revoked_at=excluded.revoked_at`,
      [consent.policyVersion, consent.provider, consent.model, consent.status,
        consent.acceptedAt, consent.revokedAt],
    ));
  }

  currentInferenceConsent(policyVersion: number): InferenceConsent | null {
    const row = this.select(
      `SELECT * FROM inference_consents WHERE policy_version=?`, [policyVersion],
    )[0];
    return row === undefined ? null : {
      policyVersion: row.policy_version as number,
      provider: row.provider as InferenceConsent['provider'],
      model: row.model as string,
      status: row.status as InferenceConsent['status'],
      acceptedAt: row.accepted_at as string,
      revokedAt: row.revoked_at as string | null,
    };
  }

  /**
   * Last scan result per server. The caller passes the timestamp: if the store read the clock,
   * tests could not pin it.
   */
  recordServerScanStatus(
    serverName: string,
    status: ServerScanStatusKind,
    scannedAt: string,
    errorCode?: string,
  ): void {
    this.run(
      `INSERT INTO server_scan_status(server_name, status, scanned_at, error_code)
       VALUES(?,?,?,?)
       ON CONFLICT(server_name) DO UPDATE SET
         status=excluded.status, scanned_at=excluded.scanned_at, error_code=excluded.error_code`,
      [serverName, status, scannedAt, errorCode ?? null]);
  }

  /** A server that was never scanned is expressed as an absent row, not as a value. */
  serverScanStatuses(): ReadonlyMap<string, ServerScanStatus> {
    const map = new Map<string, ServerScanStatus>();
    for (const r of this.select('SELECT * FROM server_scan_status', [])) {
      map.set(r.server_name as string, {
        status: r.status as ServerScanStatusKind,
        scannedAt: r.scanned_at as string,
        errorCode: (r.error_code as string | null) ?? undefined,
      });
    }
    return map;
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
      // Defends against rows written before the migration: without a value, scanned_at counts as the first observation
      firstScannedAt: (r.first_scanned_at as string | null) ?? (r.scanned_at as string),
    }));
  }

  /**
   * Server names whose definition bodies were actually ingested. This is the test for "scan complete".
   * A server with definitions but no bodies is in the legacy state from before the body table
   * existed, so it must stay a rescan target.
   */
  serversWithDefinitionBodies(): Set<string> {
    return new Set(
      this.select('SELECT DISTINCT server_name FROM tool_definition_bodies', [])
        .map((r) => r.server_name as string),
    );
  }

  /**
   * Stores server attribution. Only clients listed in replaceable have their rows replaced
   * wholesale; every other client (whose config could not be read) keeps its existing mapping.
   */
  upsertClientServers(attribution: Map<string, Set<ClientId>>,
    replaceable: Set<ClientId>): void {
    // DELETE, INSERT and retroactive attribution are one unit. A failure in the middle leaves that
    // client's attribution empty and the matrix cannot attach the server.
    this.transaction(() => {
      for (const client of replaceable)
        this.run('DELETE FROM client_servers WHERE client=?', [client]);
      for (const [serverName, clients] of attribution)
        for (const client of clients) {
          if (!replaceable.has(client)) continue; // clients we preserve are not rewritten either
          this.run(
            `INSERT INTO client_servers(client, server_name) VALUES(?,?)
             ON CONFLICT(client, server_name) DO NOTHING`,
            [client, serverName]);
        }
      // This path runs on every activation. Even on a DB where scans have settled and are skipped,
      // past loads frozen by a failed attribution recover here.
      this.reattributePendingCodexLoads();
    });
  }

  /** client -> the set of server names configured for that client. Empty map when there is no mapping. */
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
   * All-time last call timestamp per tool. The key is `${serverName} ${toolName}`.
   * It exists so past use outside the analysis window (callsSince) still affects the confidence
   * grade: with in-window calls alone, "a tool we used to use" and "a tool never used" look identical.
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
    renameSync(tmp, this.filePath); // atomic replace
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
    for (const load of materialized.toolLoads) {
      const attributed = this.attributeCodexLoadName(session.client, load);
      this.run(
        `INSERT INTO tool_loads(session_id, server_name, tool_name, loaded_tokens) VALUES(?,?,?,?)`,
        [sessionId, attributed.serverName, attributed.toolName, attributed.loadedTokens]);
    }
  }

  /** A canonical name left by Codex is split only when it uniquely matches the current scan and config. */
  private attributeCodexLoadName(client: string, load: ToolLoadEvent): ToolLoadEvent {
    if (
      client !== 'codex'
      || load.serverName !== null
      || load.toolName === '(code-mode-search)'
      || !load.toolName.startsWith('mcp__')
    ) return load;
    const candidates = this.select(
      `SELECT d.server_name, d.tool_name FROM tool_definitions d
       JOIN client_servers c ON c.server_name=d.server_name
       WHERE c.client='codex'`, [],
    ).filter((row) => `mcp__${row.server_name as string}__${row.tool_name as string}` === load.toolName);
    if (candidates.length !== 1) return load;
    return {
      ...load,
      serverName: candidates[0]!.server_name as string,
      toolName: candidates[0]!.tool_name as string,
    };
  }

  /** Recovers codex loads whose attribution failed because the scan arrived later. */
  private reattributePendingCodexLoads(): void {
    const rows = this.select(
      `SELECT DISTINCT l.session_id FROM tool_loads l
       JOIN sessions s ON s.session_id = l.session_id
       WHERE s.client = 'codex' AND l.server_name IS NULL
         AND l.tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\'`, [],
    );
    for (const row of rows) this.rebuildSession(row.session_id as string);
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

function rowToServerIdentity(row: Record<string, unknown>): ServerIdentity {
  return {
    client: row.client as ServerIdentity['client'],
    serverName: row.server_name as string,
    sourceKind: row.source_kind as ServerIdentity['sourceKind'],
    sourcePathHash: row.source_path_hash as string,
    transport: row.transport as ServerIdentity['transport'],
    endpointHash: row.endpoint_hash as string,
    conflictState: row.conflict_state as ServerIdentity['conflictState'],
    observedAt: row.observed_at as string,
  };
}

function rowToDefinitionBody(row: Record<string, unknown>): ToolDefinitionBody {
  return {
    serverName: row.server_name as string,
    toolName: row.tool_name as string,
    description: row.description as string | null,
    inputSchemaJson: row.input_schema_json as string,
    definitionTokens: row.definition_tokens as number,
    definitionSetHash: row.definition_set_hash as string,
    scannedAt: row.scanned_at as string,
  };
}

function rowToGlobalAction(row: Record<string, unknown>): GlobalAction {
  return {
    actionId: row.action_id as string,
    client: row.client as GlobalAction['client'],
    serverName: row.server_name as string,
    toolName: row.tool_name as string,
    identityHash: row.identity_hash as string,
    definitionSetHash: row.definition_set_hash as string,
    ownedRule: row.owned_rule as string,
    backupPath: row.backup_path as string,
    preFingerprint: row.pre_fingerprint as string,
    postFingerprint: row.post_fingerprint as string,
    status: row.status as GlobalAction['status'],
    createdAt: row.created_at as string,
    restoredAt: row.restored_at as string | null,
  };
}
