import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterResult, SessionMeta, ToolCallEvent, ToolDefinition,
  ToolLoadEvent } from '../types.js';

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

export class LensStore {
  private constructor(private db: Database, private filePath: string) {}

  static async open(filePath: string): Promise<LensStore> {
    const SQL = await initSqlJs();
    const db = filePath !== ':memory:' && existsSync(filePath)
      ? new SQL.Database(readFileSync(filePath))
      : new SQL.Database();
    db.exec(SCHEMA);
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
        `INSERT INTO tool_definitions(server_name, tool_name, definition_tokens, scanned_at)
         VALUES(?,?,?,?)
         ON CONFLICT(server_name, tool_name) DO UPDATE
           SET definition_tokens=excluded.definition_tokens, scanned_at=excluded.scanned_at`,
        [d.serverName, d.toolName, d.definitionTokens, d.scannedAt]);
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
      filePath: r.file_path as string, startedAt: r.started_at as string | null,
      mode: r.mode as SessionMeta['mode'],
    }));
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
