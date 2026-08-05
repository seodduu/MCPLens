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
    evidenceLabel: 'measured', evidence: EMPTY_EVIDENCE },
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
  it('builds the same space-separated key as the engine', () => {
    expect(toolCostKey('notion', 'notion-update-page')).toBe('notion notion-update-page');
  });
});

describe('callSessionCounts', () => {
  it('counts the distinct sessions that called each tool', () => {
    const m = callSessionCounts([
      call('s1', 'notion-search'), call('s2', 'notion-search'),
      call('s1', 'notion-fetch'),
    ]);
    expect(m.get('notion notion-search')).toBe(2);
    expect(m.get('notion notion-fetch')).toBe(1);
  });

  it('counts several calls in one session as 1', () => {
    const m = callSessionCounts([
      call('s1', 'notion-search'), call('s1', 'notion-search'),
      call('s1', 'notion-search'),
    ]);
    expect(m.get('notion notion-search')).toBe(1);
  });

  it('returns an empty map when there is no call', () => {
    expect(callSessionCounts([]).size).toBe(0);
  });
});

describe('cumulativeCost', () => {
  it('gives the definition tokens as they are for 1 load session and 0 calls', () => {
    const c = cumulativeCost(row({ loadedSessionCount: 1 }), 0);
    expect(c.tokens).toBe(3287);
    expect(c.definitionMeasured).toBe(true);
  });

  it('gives three times the definition tokens for 3 load sessions', () => {
    expect(cumulativeCost(row({ loadedSessionCount: 3 }), 0).tokens).toBe(9861);
  });

  it('gives 0 for 0 loads and 0 calls', () => {
    expect(cumulativeCost(row(), 0).tokens).toBe(0);
  });

  it('sums the definition loads and the call responses', () => {
    const c = cumulativeCost(row({ loadedSessionCount: 1, responseTokens: 500 }), 0);
    expect(c.tokens).toBe(3787);
  });

  it('infers double from the calls when there are 0 loads and calls in 2 sessions', () => {
    expect(cumulativeCost(row({ callCount: 2 }), 2).tokens).toBe(6574);
  });

  it('takes the larger side, three times, for 3 loads and calls in 1 session', () => {
    expect(cumulativeCost(row({ loadedSessionCount: 3, callCount: 1 }), 1).tokens).toBe(9861);
  });

  it('keeps the response part and marks it unmeasured when the definition is unmeasured', () => {
    const c = cumulativeCost(
      row({ definitionTokens: null, callCount: 1, responseTokens: 50 }), 1);
    expect(c.tokens).toBe(50);
    expect(c.definitionMeasured).toBe(false);
  });

  it('counts as measured when loads and calls are 0, since the definition part really is 0 even if unmeasured', () => {
    const c = cumulativeCost(row({ definitionTokens: null }), 0);
    expect(c.tokens).toBe(0);
    expect(c.definitionMeasured).toBe(true);
  });
});
