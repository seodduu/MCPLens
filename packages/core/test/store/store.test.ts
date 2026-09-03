import { describe, it, expect } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import type { AdapterResult } from '../../src/types.js';
import initSqlJs from 'sql.js';
import { writeFileSync } from 'node:fs';

function fakeResult(sessionId: string, calls = 2): AdapterResult {
  return {
    session: { sessionId, client: 'claude-code', filePath: `/f/${sessionId}.jsonl`,
      startedAt: '2026-07-01T00:00:00Z', mode: 'DEFERRED_MEASURABLE' },
    toolCalls: Array.from({ length: calls }, (_, i) => ({
      sessionId, serverName: 'github', toolName: `tool${i}`,
      calledAt: '2026-07-01T00:01:00Z', durationMs: 100, isError: false,
      responseTokens: 50, responseText: null })),
    toolLoads: [{ sessionId, serverName: 'github', toolName: 'tool0', loadedTokens: null }],
    usage: [{ sessionId, at: '2026-07-01T00:01:00Z', inputTokens: 1000,
      outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    parseErrors: 0,
  };
}

describe('LensStore', () => {
  it('finds only recent restored actions with the same identity and definition', async () => {
    const s = await LensStore.open(':memory:');
    const base = {
      actionId: 'restored-1', client: 'claude-code' as const, serverName: 'github', toolName: 'search',
      identityHash: 'identity', definitionSetHash: 'definition-a', ownedRule: 'mcp__github__search',
      backupPath: '/tmp/backup', preFingerprint: 'before', postFingerprint: 'after',
      status: 'restored' as const, createdAt: '2026-08-01T00:00:00.000Z', restoredAt: '2026-08-08T00:00:00.000Z',
    };
    s.recordGlobalAction(base);
    expect(s.hasRestoredActionSince('claude-code', 'github', 'search', 'definition-a', '2026-08-02T00:00:00.000Z')).toBe(true);
    expect(s.hasRestoredActionSince('claude-code', 'github', 'search', 'definition-a', '2026-08-09T00:00:00.000Z')).toBe(false);
    expect(s.hasRestoredActionSince('claude-code', 'github', 'search', 'definition-b', '2026-08-02T00:00:00.000Z')).toBe(false);
  });

  it('matches restored-action cooldown on client, server, tool, hash, status, restoredAt, and cutoff', async () => {
    const s = await LensStore.open(':memory:');
    const base = {
      client: 'claude-code' as const, serverName: 'github', toolName: 'search', identityHash: 'identity',
      definitionSetHash: 'definition-a', ownedRule: 'mcp__github__search', backupPath: '/tmp/backup',
      preFingerprint: 'before', postFingerprint: 'after', createdAt: '2026-08-01T00:00:00.000Z',
    };
    s.recordGlobalAction({ ...base, actionId: 'matching', status: 'restored', restoredAt: '2026-08-08T00:00:00.000Z' });
    s.recordGlobalAction({ ...base, actionId: 'other-client', client: 'codex', status: 'restored', restoredAt: '2026-08-08T00:00:00.000Z' });
    s.recordGlobalAction({ ...base, actionId: 'other-server', serverName: 'gitlab', status: 'restored', restoredAt: '2026-08-08T00:00:00.000Z' });
    s.recordGlobalAction({ ...base, actionId: 'other-tool', toolName: 'get_file', status: 'restored', restoredAt: '2026-08-08T00:00:00.000Z' });
    s.recordGlobalAction({ ...base, actionId: 'other-hash', definitionSetHash: 'definition-b', status: 'restored', restoredAt: '2026-08-08T00:00:00.000Z' });
    s.recordGlobalAction({ ...base, actionId: 'active', status: 'active', restoredAt: null });
    s.recordGlobalAction({ ...base, actionId: 'restored-null', status: 'restored', restoredAt: null });
    expect(s.hasRestoredActionSince('claude-code', 'github', 'search', 'definition-a', '2026-08-08T00:00:00.000Z')).toBe(true);
    expect(s.hasRestoredActionSince('claude-code', 'github', 'search', 'definition-a', '2026-08-08T00:00:00.001Z')).toBe(false);
    expect(s.hasRestoredActionSince('claude-code', 'gitlab', 'get_file', 'definition-a', '2026-08-02T00:00:00.000Z')).toBe(false);
  });

  it('does not treat active or restored-at-null actions as a restored cooldown', async () => {
    const s = await LensStore.open(':memory:');
    const base = {
      client: 'claude-code' as const, serverName: 'github', toolName: 'search', identityHash: 'identity',
      definitionSetHash: 'definition-a', ownedRule: 'mcp__github__search', backupPath: '/tmp/backup',
      preFingerprint: 'before', postFingerprint: 'after', createdAt: '2026-08-01T00:00:00.000Z',
    };
    s.recordGlobalAction({ ...base, actionId: 'active', status: 'active', restoredAt: null });
    s.recordGlobalAction({ ...base, actionId: 'restored-null', status: 'restored', restoredAt: null });
    expect(s.hasRestoredActionSince('claude-code', 'github', 'search', 'definition-a', '2026-08-02T00:00:00.000Z')).toBe(false);
  });

  it('can be queried after ingest', async () => {
    const s = await LensStore.open(':memory:');
    s.ingest(fakeResult('s1'));
    expect(s.callsSince('2026-01-01')).toHaveLength(2);
    expect(s.sessionsSince('2026-01-01')).toHaveLength(1);
  });

  it('makes re-ingesting the same session idempotent (no double counting)', async () => {
    const s = await LensStore.open(':memory:');
    s.ingest(fakeResult('s1'));
    s.ingest(fakeResult('s1', 3)); // re-parse: updated to 3 calls
    expect(s.callsSince('2026-01-01')).toHaveLength(3); // 3, not 2+3=5
  });

  it('round-trips the cursor through get/set', async () => {
    const s = await LensStore.open(':memory:');
    expect(s.getCursor('/a')).toBeNull();
    s.setCursor('/a', 1024, 999);
    expect(s.getCursor('/a')).toEqual({ byteOffset: 1024, mtimeMs: 999 });
  });

  it('persists save to the file and keeps the data on reopen', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lens-test-${Date.now()}.db`;
    const s = await LensStore.open(tmp);
    s.ingest(fakeResult('s1'));
    s.save(); s.close();
    const s2 = await LensStore.open(tmp);
    expect(s2.callsSince('2026-01-01')).toHaveLength(2);
    s2.close();
  });

  it('filters loadsSince by the session start date (M6)', async () => {
    const s = await LensStore.open(':memory:');
    const old = fakeResult('old'); old.session.startedAt = '2026-01-01T00:00:00Z';
    old.toolLoads = [{ sessionId: 'old', serverName: 'github', toolName: 'a', loadedTokens: 10 }];
    const recent = fakeResult('recent'); recent.session.startedAt = '2026-07-01T00:00:00Z';
    recent.toolLoads = [{ sessionId: 'recent', serverName: 'github', toolName: 'b', loadedTokens: 20 }];
    s.ingest(old); s.ingest(recent);
    const loads = s.loadsSince('2026-06-01');
    expect(loads.map((l) => l.toolName)).toEqual(['b']); // old is excluded
  });

  it('conservatively includes loads of sessions with a null startedAt', async () => {
    const s = await LensStore.open(':memory:');
    const r = fakeResult('x'); r.session.startedAt = null;
    r.toolLoads = [{ sessionId: 'x', serverName: 'g', toolName: 't', loadedTokens: 5 }];
    s.ingest(r);
    expect(s.loadsSince('2026-06-01')).toHaveLength(1);
  });

  it('preserves the original first_scanned_at across two upserts', async () => {
    const s = await LensStore.open(':memory:');
    s.upsertDefinitions([{ serverName: 'github', toolName: 'a',
      definitionTokens: 100, advertisedTokens: null, nameListTokens: null, estimatorVersion: 'v1',
      scannedAt: '2026-01-01T00:00:00Z', firstScannedAt: '2026-01-01T00:00:00Z' }]);
    s.upsertDefinitions([{ serverName: 'github', toolName: 'a',
      definitionTokens: 120, advertisedTokens: null, nameListTokens: null, estimatorVersion: 'v1',
      scannedAt: '2026-07-01T00:00:00Z', firstScannedAt: '2026-07-01T00:00:00Z' }]);
    const [d] = s.allDefinitions();
    expect(d.definitionTokens).toBe(120);              // updated to the newest value
    expect(d.scannedAt).toBe('2026-07-01T00:00:00Z');  // updated to the newest value
    expect(d.firstScannedAt).toBe('2026-01-01T00:00:00Z'); // the original is preserved
  });

  it('adds the column and backfills it from scanned_at when opening an old-schema DB without first_scanned_at', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lens-migrate-${Date.now()}.db`;
    // Hand-build an old-schema DB (no first_scanned_at column)
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(`CREATE TABLE tool_definitions (
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL,
      definition_tokens INTEGER NOT NULL, scanned_at TEXT NOT NULL,
      PRIMARY KEY (server_name, tool_name));
      INSERT INTO tool_definitions VALUES('github','old',700,'2026-02-02T00:00:00Z');`);
    writeFileSync(tmp, Buffer.from(legacy.export()));
    legacy.close();

    const s = await LensStore.open(tmp);
    const [d] = s.allDefinitions();
    expect(d.toolName).toBe('old');
    expect(d.firstScannedAt).toBe('2026-02-02T00:00:00Z'); // backfilled from scanned_at
    s.close();
  });

  it('returns only the server names whose bodies were ingested', async () => {
    const s = await LensStore.open(':memory:');
    // upsertScanResult ingests a with its bodies; b gets only definitions through upsertDefinitions
    s.upsertScanResult(
      [{ serverName: 'a', toolName: 'tool', definitionTokens: 10,
        advertisedTokens: null, nameListTokens: null, estimatorVersion: 'v1',
        scannedAt: '2026-08-01T00:00:00Z', firstScannedAt: '2026-08-01T00:00:00Z' }],
      [{ serverName: 'a', toolName: 'tool', description: 'd', inputSchemaJson: '{}',
        outputSchemaJson: null, definitionTokens: 10, definitionSetHash: 'a'.repeat(64), scannedAt: '2026-08-01T00:00:00Z' }],
      [],
    );
    s.upsertDefinitions([{ serverName: 'b', toolName: 'tool', definitionTokens: 10,
      advertisedTokens: null, nameListTokens: null, estimatorVersion: 'v1',
      scannedAt: '2026-08-01T00:00:00Z', firstScannedAt: '2026-08-01T00:00:00Z' }]);
    expect([...s.serversWithDefinitionBodies()]).toEqual(['a']);
  });

  it('returns an empty set when the body table is empty', async () => {
    const s = await LensStore.open(':memory:');
    expect(s.serversWithDefinitionBodies().size).toBe(0);
  });

  it('gives the all-time last call timestamp per tool through lastCallByTool', async () => {
    const s = await LensStore.open(':memory:');
    const old = fakeResult('old', 0);
    old.session.startedAt = '2026-01-01T00:00:00Z';
    old.toolCalls = [{ sessionId: 'old', serverName: 'github', toolName: 'stale',
      calledAt: '2026-01-05T00:00:00Z', durationMs: 1, isError: false,
      responseTokens: 10, responseText: null }];
    s.ingest(old);
    expect(s.lastCallByTool().get('github stale')).toBe('2026-01-05T00:00:00Z');
    expect(s.lastCallByTool().get('github ghost')).toBeUndefined();
  });
});
