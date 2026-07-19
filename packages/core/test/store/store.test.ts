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
  it('ingest 후 조회된다', async () => {
    const s = await LensStore.open(':memory:');
    s.ingest(fakeResult('s1'));
    expect(s.callsSince('2026-01-01')).toHaveLength(2);
    expect(s.sessionsSince('2026-01-01')).toHaveLength(1);
  });

  it('같은 세션 재적재는 멱등 (이중계상 없음)', async () => {
    const s = await LensStore.open(':memory:');
    s.ingest(fakeResult('s1'));
    s.ingest(fakeResult('s1', 3)); // 재파싱: 3콜로 갱신
    expect(s.callsSince('2026-01-01')).toHaveLength(3); // 2+3=5가 아니라 3
  });

  it('커서 get/set 왕복', async () => {
    const s = await LensStore.open(':memory:');
    expect(s.getCursor('/a')).toBeNull();
    s.setCursor('/a', 1024, 999);
    expect(s.getCursor('/a')).toEqual({ byteOffset: 1024, mtimeMs: 999 });
  });

  it('save는 파일로 영속화되고 재open 시 데이터가 남는다', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lens-test-${Date.now()}.db`;
    const s = await LensStore.open(tmp);
    s.ingest(fakeResult('s1'));
    s.save(); s.close();
    const s2 = await LensStore.open(tmp);
    expect(s2.callsSince('2026-01-01')).toHaveLength(2);
    s2.close();
  });

  it('loadsSince는 세션 시작일로 기간 필터한다 (M6)', async () => {
    const s = await LensStore.open(':memory:');
    const old = fakeResult('old'); old.session.startedAt = '2026-01-01T00:00:00Z';
    old.toolLoads = [{ sessionId: 'old', serverName: 'github', toolName: 'a', loadedTokens: 10 }];
    const recent = fakeResult('recent'); recent.session.startedAt = '2026-07-01T00:00:00Z';
    recent.toolLoads = [{ sessionId: 'recent', serverName: 'github', toolName: 'b', loadedTokens: 20 }];
    s.ingest(old); s.ingest(recent);
    const loads = s.loadsSince('2026-06-01');
    expect(loads.map((l) => l.toolName)).toEqual(['b']); // old는 제외
  });

  it('startedAt이 null인 세션의 로드는 보수적으로 포함한다', async () => {
    const s = await LensStore.open(':memory:');
    const r = fakeResult('x'); r.session.startedAt = null;
    r.toolLoads = [{ sessionId: 'x', serverName: 'g', toolName: 't', loadedTokens: 5 }];
    s.ingest(r);
    expect(s.loadsSince('2026-06-01')).toHaveLength(1);
  });

  it('upsert를 2회 해도 first_scanned_at은 최초값을 보존한다', async () => {
    const s = await LensStore.open(':memory:');
    s.upsertDefinitions([{ serverName: 'github', toolName: 'a',
      definitionTokens: 100, scannedAt: '2026-01-01T00:00:00Z',
      firstScannedAt: '2026-01-01T00:00:00Z' }]);
    s.upsertDefinitions([{ serverName: 'github', toolName: 'a',
      definitionTokens: 120, scannedAt: '2026-07-01T00:00:00Z',
      firstScannedAt: '2026-07-01T00:00:00Z' }]);
    const [d] = s.allDefinitions();
    expect(d.definitionTokens).toBe(120);              // 최신값으로 갱신
    expect(d.scannedAt).toBe('2026-07-01T00:00:00Z');  // 최신값으로 갱신
    expect(d.firstScannedAt).toBe('2026-01-01T00:00:00Z'); // 최초값 보존
  });

  it('first_scanned_at 없는 구스키마 DB를 열면 컬럼이 추가되고 scanned_at으로 백필된다', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lens-migrate-${Date.now()}.db`;
    // 구스키마 DB를 손으로 만든다 (first_scanned_at 컬럼 없음)
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
    expect(d.firstScannedAt).toBe('2026-02-02T00:00:00Z'); // scanned_at으로 백필
    s.close();
  });

  it('lastCallByTool은 전 기간 기준 툴별 마지막 호출 시각을 준다', async () => {
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
