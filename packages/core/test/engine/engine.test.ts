// packages/core/test/engine/engine.test.ts
import { describe, it, expect } from 'vitest';
import { buildMatrix, sessionSavings } from '../../src/engine/engine.js';
import type { EngineInput } from '../../src/engine/engine.js';

const def = (tool: string, tokens: number) => ({
  serverName: 'github', toolName: tool, definitionTokens: tokens,
  scannedAt: '2026-07-19T00:00:00Z' });
const call = (tool: string) => ({
  sessionId: 's1', serverName: 'github', toolName: tool,
  calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError: false,
  responseTokens: 100, responseText: null });
const session = (mode: any) => ({
  sessionId: 's1', client: 'claude-code' as const, filePath: '/f',
  startedAt: '2026-07-10T00:00:00Z', mode });

describe('buildMatrix', () => {
  it('호출 0회 + 정의 있음 → remove 권고', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('800');   // 업프론트 → 크기 명시
    expect(row.recommendation.evidenceLabel).toBe('전량 가정');
  });

  it('지연 로딩 세션에서는 같은 판정, 다른 표기', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('검색 공간');
    expect(row.recommendation.evidenceLabel).toBe('실측');
  });

  it('서버 40툴 중 2개만 사용 → 미사용 툴은 filter-server', () => {
    const defs = Array.from({ length: 40 }, (_, i) => def(`t${i}`, 100));
    const input: EngineInput = {
      definitions: defs, calls: [call('t0'), call('t1')], loads: [],
      sessions: [session('UPFRONT')],
    };
    const rows = buildMatrix(input);
    expect(rows.find((r) => r.toolName === 't5')!.recommendation.action).toBe('filter-server');
    expect(rows.find((r) => r.toolName === 't0')!.recommendation.action).toBe('keep');
  });
});

describe('sessionSavings', () => {
  it('잠재 = 정의 전량, 실비용 = 로드분, 절감 = 차이', () => {
    const input: EngineInput = {
      definitions: [def('a', 500), def('b', 700)],
      calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.potentialTokens).toBe(1200);
    expect(s.actualTokens).toBe(500);  // 로드된 a만 — 이름 조인으로 500 산출
    expect(s.savedTokens).toBe(700);
  });
});
