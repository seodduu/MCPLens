import { afterEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LensStore } from '../../src/store/store.js';
import type { AdapterResult, ToolDefinition, ToolDefinitionBody } from '../../src/types.js';

const NOW = '2026-08-08T00:00:00.000Z';
const temporaryRoots: string[] = [];

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcplens-output-schema-'));
  temporaryRoots.push(root);
  return join(root, 'lens.db');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes a database whose v2 tables predate output_schema_json and observed_session_count. */
async function writeLegacyDatabase(path: string): Promise<void> {
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE tool_definition_bodies (
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL, description TEXT,
      input_schema_json TEXT NOT NULL, definition_tokens INTEGER NOT NULL,
      definition_set_hash TEXT NOT NULL, scanned_at TEXT NOT NULL,
      PRIMARY KEY (server_name, tool_name));
    INSERT INTO tool_definition_bodies
      VALUES('github','get_issue','Get an issue','{"type":"object"}',120,'legacy-hash','${NOW}');
    CREATE TABLE dependency_analyses (
      definition_set_hash TEXT NOT NULL, analysis_rules_version INTEGER NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
      analyzed_at TEXT NOT NULL, error_code TEXT,
      PRIMARY KEY (definition_set_hash, analysis_rules_version));
    INSERT INTO dependency_analyses
      VALUES('legacy-hash',1,'claude','haiku','complete','${NOW}',NULL);`);
  writeFileSync(path, Buffer.from(legacy.export()));
  legacy.close();
}

function definition(toolName: string): ToolDefinition {
  return { serverName: 'github', toolName, definitionTokens: 10, advertisedTokens: null, nameListTokens: null,
    estimatorVersion: 'v1', scannedAt: NOW, firstScannedAt: NOW };
}

function body(toolName: string, outputSchemaJson: string | null): ToolDefinitionBody {
  return {
    serverName: 'github', toolName, description: `Run ${toolName}`,
    inputSchemaJson: '{"type":"object"}', outputSchemaJson,
    definitionTokens: 10, definitionSetHash: 'hash-v1', scannedAt: NOW,
  };
}

function callSession(sessionId: string, calls: Array<{
  serverName: string; toolName: string; calledAt: string; isError?: boolean;
}>): AdapterResult {
  return {
    session: { sessionId, client: 'claude-code', filePath: `/logs/${sessionId}.jsonl`, startedAt: NOW, mode: 'UPFRONT' },
    toolCalls: calls.map((call) => ({
      sessionId, serverName: call.serverName, toolName: call.toolName,
      calledAt: call.calledAt, durationMs: 5, isError: call.isError ?? false,
      responseTokens: 10, responseText: null,
    })),
    toolLoads: [], usage: [], parseErrors: 0,
  };
}

describe('output schema and observed session count contracts', () => {
  it('adds both columns to a legacy database while preserving the existing rows', async () => {
    const path = temporaryDatabase();
    await writeLegacyDatabase(path);

    const store = await LensStore.open(path);
    expect(store.definitionBodiesForServer('github')).toEqual([{
      serverName: 'github', toolName: 'get_issue', description: 'Get an issue',
      inputSchemaJson: '{"type":"object"}', outputSchemaJson: null,
      definitionTokens: 120, definitionSetHash: 'legacy-hash', scannedAt: NOW,
    }]);
    const analysis = store.findDependencyAnalysis('legacy-hash', 1);
    expect(analysis?.model).toBe('haiku');
    expect(analysis?.observedSessionCount).toBe(0);
    store.close();
  });

  it('runs the migration a second time without failing and keeps the migrated data', async () => {
    const path = temporaryDatabase();
    await writeLegacyDatabase(path);

    const first = await LensStore.open(path);
    first.upsertScanResult([definition('get_issue')], [body('get_issue', '{"type":"string"}')], []);
    first.close();

    // A second open re-runs migrate() against a database that already has both columns.
    const second = await LensStore.open(path);
    second.reload();
    expect(second.definitionBodiesForServer('github')[0]?.outputSchemaJson).toBe('{"type":"string"}');
    second.close();
  });

  it('round-trips a scan that mixes tools with and without an output schema', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertScanResult(
      [definition('with_output'), definition('without_output')],
      [body('with_output', '{"type":"object","properties":{"ok":{"type":"boolean"}}}'),
        body('without_output', null)],
      [],
    );

    const rows = store.definitionBodiesForServer('github');
    expect(rows.map((row) => row.outputSchemaJson)).toEqual([
      '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
      null,
    ]);
    store.close();
  });

  it('round-trips observedSessionCount instead of defaulting it to zero', async () => {
    const store = await LensStore.open(':memory:');
    store.saveDependencyAnalysis({
      definitionSetHash: 'hash-v1', analysisRulesVersion: 1, provider: 'claude', model: 'haiku',
      status: 'complete', analyzedAt: NOW, errorCode: null, observedSessionCount: 7, results: [],
    });

    expect(store.findDependencyAnalysis('hash-v1', 1)?.observedSessionCount).toBe(7);
    store.close();
  });

  it('counts distinct sessions inside the window, including error-only calls', async () => {
    const store = await LensStore.open(':memory:');
    const since = '2026-05-10T00:00:00.000Z'; // 90 days before NOW
    store.ingest(callSession('session-a', [
      { serverName: 'github', toolName: 'get_issue', calledAt: '2026-08-01T00:00:00.000Z' },
      { serverName: 'github', toolName: 'search', calledAt: '2026-08-02T00:00:00.000Z' },
    ]));
    store.ingest(callSession('session-b', [
      { serverName: 'github', toolName: 'get_issue', calledAt: '2026-08-03T00:00:00.000Z', isError: true },
    ]));
    store.ingest(callSession('session-old', [
      { serverName: 'github', toolName: 'get_issue', calledAt: '2026-01-01T00:00:00.000Z' },
    ]));
    store.ingest(callSession('session-other', [
      { serverName: 'notion', toolName: 'search', calledAt: '2026-08-04T00:00:00.000Z' },
    ]));

    expect(store.sessionCountForServer('github', since)).toBe(2);
    expect(store.sessionCountForServer('notion', since)).toBe(1);
    expect(store.sessionCountForServer('absent', since)).toBe(0);
    store.close();
  });
});
