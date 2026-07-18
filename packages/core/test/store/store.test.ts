import { describe, it, expect } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import type { AdapterResult } from '../../src/types.js';

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
});
