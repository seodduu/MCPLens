import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterResult, SessionMeta, ToolCallEvent, ToolDefinition,
  ToolLoadEvent } from '../types.js';

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

export class LensStore {
  private constructor(private db: Database, private filePath: string) {}
  observationCount(): number { const r = this.select('SELECT COUNT(*) AS count FROM ingest_observations', []); return Number(r[0]?.count ?? 0); }

  static async open(filePath: string): Promise<LensStore> {
    const SQL = await initSqlJs();
    const db = filePath !== ':memory:' && existsSync(filePath)
      ? new SQL.Database(readFileSync(filePath))
      : new SQL.Database();
    db.exec(SCHEMA);
    migrate(db);
    return new LensStore(db, filePath);
  }

  ingest(r: AdapterResult): void {
    const { session: s } = r;
    this.db.exec('BEGIN');
    try {
      this.run(
        `INSERT INTO sessions(session_id, client, file_path, started_at, mode)
         VALUES(?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, started_at=excluded.started_at`,
        [s.sessionId, s.client, s.filePath, s.startedAt, s.mode]);
      for (const t of ['tool_calls', 'tool_loads', 'token_usage'])
        this.run(`DELETE FROM ${t} WHERE session_id = ?`, [s.sessionId]);
      for (const c of r.toolCalls)
        this.run(
          `INSERT INTO tool_calls(session_id, server_name, tool_name, called_at,
             duration_ms, is_error, response_tokens) VALUES(?,?,?,?,?,?,?)`,
          [c.sessionId, c.serverName, c.toolName, c.calledAt, c.durationMs,
           c.isError ? 1 : 0, c.responseTokens]);
      for (const l of r.toolLoads)
        this.run(
          `INSERT INTO tool_loads(session_id, server_name, tool_name, loaded_tokens)
           VALUES(?,?,?,?)`,
          [l.sessionId, l.serverName, l.toolName, l.loadedTokens]);
      for (const u of r.usage)
        this.run(
          `INSERT INTO token_usage(session_id, at, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens) VALUES(?,?,?,?,?,?)`,
          [u.sessionId, u.at, u.inputTokens, u.outputTokens,
           u.cacheReadTokens, u.cacheCreationTokens]);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  upsertDefinitions(defs: ToolDefinition[]): void {
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, Buffer.from(this.db.export()));
    renameSync(tmp, this.filePath); // 원자적 교체
  }
  close(): void { this.db.close(); }

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
