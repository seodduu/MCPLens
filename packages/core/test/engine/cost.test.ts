// packages/core/test/engine/cost.test.ts
import { describe, it, expect } from 'vitest';
import { callSessionCounts, cumulativeCost, toolCostKey } from '../../src/engine/cost.js';
import { EMPTY_EVIDENCE } from '../../src/engine/evidence.js';
import type { MatrixRow, ToolCallEvent } from '../../src/types.js';

const row = (over: Partial<MatrixRow> = {}): MatrixRow => ({
  serverName: 'notion', toolName: 'notion-update-page',
  definitionTokens: 3287, callCount: 0, responseTokens: 0,
  loadedSessionCount: 0, sessionCount: 1,
  recommendation: { action: 'remove', confidence: 'low', reason: '',
    reasonParts: { basis: '', serverBasis: null, effect: null, caveat: null },
    evidenceLabel: '실측', evidence: EMPTY_EVIDENCE },
  reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
  loadPattern: null,
  ...over,
});

const call = (sessionId: string, tool: string): ToolCallEvent => ({
  sessionId, serverName: 'notion', toolName: tool,
  calledAt: '2026-07-10T00:00:00Z', durationMs: null, isError: false,
  responseTokens: 50, responseText: null,
});

describe('toolCostKey', () => {
  it('엔진과 같은 공백 구분 키를 만든다', () => {
    expect(toolCostKey('notion', 'notion-update-page')).toBe('notion notion-update-page');
  });
});

describe('callSessionCounts', () => {
  it('툴별 호출된 고유 세션 수를 센다', () => {
    const m = callSessionCounts([
      call('s1', 'notion-search'), call('s2', 'notion-search'),
      call('s1', 'notion-fetch'),
    ]);
    expect(m.get('notion notion-search')).toBe(2);
    expect(m.get('notion notion-fetch')).toBe(1);
  });

  it('같은 세션에서 여러 번 호출해도 1로 센다', () => {
    const m = callSessionCounts([
      call('s1', 'notion-search'), call('s1', 'notion-search'),
      call('s1', 'notion-search'),
    ]);
    expect(m.get('notion notion-search')).toBe(1);
  });

  it('호출이 없으면 빈 맵이다', () => {
    expect(callSessionCounts([]).size).toBe(0);
  });
});

describe('cumulativeCost', () => {
  it('로드 1세션·호출 0 → 정의 토큰 그대로', () => {
    const c = cumulativeCost(row({ loadedSessionCount: 1 }), 0);
    expect(c.tokens).toBe(3287);
    expect(c.definitionMeasured).toBe(true);
  });

  it('로드 3세션 → 정의 토큰의 3배', () => {
    expect(cumulativeCost(row({ loadedSessionCount: 3 }), 0).tokens).toBe(9861);
  });

  it('로드 0·호출 0 → 0', () => {
    expect(cumulativeCost(row(), 0).tokens).toBe(0);
  });

  it('정의 로드분과 호출 응답분을 합산한다', () => {
    const c = cumulativeCost(row({ loadedSessionCount: 1, responseTokens: 500 }), 0);
    expect(c.tokens).toBe(3787);
  });

  it('로드 0·2세션에서 호출 → 호출 기반으로 역산해 2배', () => {
    expect(cumulativeCost(row({ callCount: 2 }), 2).tokens).toBe(6574);
  });

  it('로드 3·호출 1세션 → 큰 쪽인 3배를 택한다', () => {
    expect(cumulativeCost(row({ loadedSessionCount: 3, callCount: 1 }), 1).tokens).toBe(9861);
  });

  it('정의 미측정 + 응답 있음 → 응답분은 남기고 미측정으로 표시한다', () => {
    const c = cumulativeCost(
      row({ definitionTokens: null, callCount: 1, responseTokens: 50 }), 1);
    expect(c.tokens).toBe(50);
    expect(c.definitionMeasured).toBe(false);
  });

  it('정의 미측정이어도 로드·호출이 0이면 정의분이 실제로 0이므로 측정됨으로 본다', () => {
    const c = cumulativeCost(row({ definitionTokens: null }), 0);
    expect(c.tokens).toBe(0);
    expect(c.definitionMeasured).toBe(true);
  });
});
