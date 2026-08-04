import { describe, it, expect } from 'vitest';
import records from '../../../../fixtures/dependency/call-chains.json' assert { type: 'json' };
import { findCallChainDependencies } from '../../src/dependency/callChains.js';
import type { DependencyCallRecord } from '../../src/types.js';

describe('findCallChainDependencies', () => {
  it('최근 90일 성공 호출에서 A-before-B가 3세션 이상, 80% 이상이면 A를 B의 blocker로 센다', () => {
    expect(findCallChainDependencies(records as DependencyCallRecord[], {
      now: '2026-08-03T00:02:00.000Z',
    })).toEqual([
      {
        serverName: 'github',
        toolName: 'search_repos',
        dependedOnBy: ['get_repo'],
        evidence: ['call-chain:get_repo:3/3'],
      },
    ]);
  });

  it('실패 호출과 A 없는 B 성공 세션 2개 이상은 blocker에서 제외한다', () => {
    const calls: DependencyCallRecord[] = [
      { sequence: 1, sessionId: 's1', serverName: 's', toolName: 'a', calledAt: '2026-08-01T00:00:00.000Z', isError: false },
      { sequence: 2, sessionId: 's1', serverName: 's', toolName: 'b', calledAt: '2026-08-01T00:01:00.000Z', isError: false },
      { sequence: 3, sessionId: 's2', serverName: 's', toolName: 'a', calledAt: '2026-08-02T00:00:00.000Z', isError: true },
      { sequence: 4, sessionId: 's2', serverName: 's', toolName: 'b', calledAt: '2026-08-02T00:01:00.000Z', isError: false },
      { sequence: 5, sessionId: 's3', serverName: 's', toolName: 'b', calledAt: '2026-08-03T00:01:00.000Z', isError: false },
    ];

    expect(findCallChainDependencies(calls, { now: '2026-08-03T00:02:00.000Z' })).toEqual([]);
  });
});
