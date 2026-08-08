import { describe, it, expect } from 'vitest';
import records from '../../../../fixtures/dependency/call-chains.json' assert { type: 'json' };
import { findCallChainDependencies, CALL_CHAIN_MIN_SESSIONS } from '../../src/dependency/callChains.js';
import type { DependencyCallRecord } from '../../src/types.js';

describe('findCallChainDependencies', () => {
  it('counts A as a blocker of B when A-before-B appears in >=3 sessions and >=80% of successful calls in the last 90 days', () => {
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

  it('excludes failed calls and >=2 successful B sessions without A from the blockers', () => {
    const calls: DependencyCallRecord[] = [
      { sequence: 1, sessionId: 's1', serverName: 's', toolName: 'a', calledAt: '2026-08-01T00:00:00.000Z', isError: false },
      { sequence: 2, sessionId: 's1', serverName: 's', toolName: 'b', calledAt: '2026-08-01T00:01:00.000Z', isError: false },
      { sequence: 3, sessionId: 's2', serverName: 's', toolName: 'a', calledAt: '2026-08-02T00:00:00.000Z', isError: true },
      { sequence: 4, sessionId: 's2', serverName: 's', toolName: 'b', calledAt: '2026-08-02T00:01:00.000Z', isError: false },
      { sequence: 5, sessionId: 's3', serverName: 's', toolName: 'b', calledAt: '2026-08-03T00:01:00.000Z', isError: false },
    ];

    expect(findCallChainDependencies(calls, { now: '2026-08-03T00:02:00.000Z' })).toEqual([]);
  });

  it('keeps the three-session threshold after extracting the constant', () => {
    expect(CALL_CHAIN_MIN_SESSIONS).toBe(3);

    const session = (id: string, day: string): DependencyCallRecord[] => [
      { sequence: 1, sessionId: id, serverName: 's', toolName: 'a', calledAt: `2026-08-0${day}T00:00:00.000Z`, isError: false },
      { sequence: 2, sessionId: id, serverName: 's', toolName: 'b', calledAt: `2026-08-0${day}T00:01:00.000Z`, isError: false },
    ];
    const twoSessions = [...session('s1', '1'), ...session('s2', '2')];
    const threeSessions = [...twoSessions, ...session('s3', '3')];

    expect(findCallChainDependencies(twoSessions, { now: '2026-08-04T00:00:00.000Z' })).toEqual([]);
    expect(findCallChainDependencies(threeSessions, { now: '2026-08-04T00:00:00.000Z' })).toEqual([
      {
        serverName: 's',
        toolName: 'a',
        dependedOnBy: ['b'],
        evidence: ['call-chain:b:3/3'],
      },
    ]);
  });
});
