import { describe, expect, it } from 'vitest';
import {
  CORRELATION_GRACE_MS,
  deriveCollectionHealth,
  type CollectionHealthObservation,
} from '../../src/health/collectionHealth.js';

const NOW = Date.parse('2026-07-20T12:00:00.000Z');

function event(
  source: CollectionHealthObservation['source'],
  phase: CollectionHealthObservation['phase'],
  correlationKey: string | null,
  offsetMs: number,
): CollectionHealthObservation {
  return { source, phase, correlationKey, observedAt: new Date(NOW + offsetMs).toISOString() };
}

const matched = (key: string, offsetMs: number): CollectionHealthObservation[] => [
  event('hook', 'tool-after', key, offsetMs),
  event('log', 'tool-after', key, offsetMs + 1),
];

describe('deriveCollectionHealth', () => {
  it('keeps an inactive collector idle instead of degrading it', () => {
    const snapshot = deriveCollectionHealth({ now: new Date(NOW).toISOString(), observations: [] });

    expect(snapshot.health).toBe('idle');
    expect(snapshot.consecutiveMisses).toBe(0);
  });

  it('does not treat a first event still inside the correlation grace as a failure', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [event('log', 'tool-after', 'waiting', -CORRELATION_GRACE_MS + 1)],
    });

    expect(snapshot.health).toBe('log-only');
    expect(snapshot.waitingForCorrelation).toBe(1);
    expect(snapshot.consecutiveMisses).toBe(0);
  });

  it('matures an unmatched log observation at the exact grace boundary', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [event('log', 'tool-after', 'boundary-miss', -CORRELATION_GRACE_MS)],
    });

    expect(snapshot.health).toBe('log-only');
    expect(snapshot.waitingForCorrelation).toBe(0);
    expect(snapshot.consecutiveMisses).toBe(1);
  });

  it('keeps healthy after one mature correlated miss', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        ...matched('match', -50_000),
        event('log', 'tool-after', 'miss', -CORRELATION_GRACE_MS - 1),
      ],
    });

    expect(snapshot.health).toBe('healthy');
    expect(snapshot.consecutiveMisses).toBe(1);
  });

  it('degrades after three consecutive mature correlation misses', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        ...matched('match', -60_000),
        event('log', 'tool-after', 'miss-1', -40_000),
        event('log', 'tool-after', 'miss-2', -30_000),
        event('log', 'tool-after', 'miss-3', -20_000),
      ],
    });

    expect(snapshot.health).toBe('degraded');
    expect(snapshot.consecutiveMisses).toBe(3);
  });

  it('does not retroactively match a hook that arrives after the grace window', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('log', 'tool-after', 'late-1', -60_000),
        event('hook', 'tool-after', 'late-1', -49_999),
        event('log', 'tool-after', 'late-2', -40_000),
        event('hook', 'tool-after', 'late-2', -29_999),
        event('log', 'tool-after', 'late-3', -20_000),
        event('hook', 'tool-after', 'late-3', -9_999),
      ],
    });

    expect(snapshot.health).toBe('degraded');
  });

  it('matches each completed hook observation to at most one log observation', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-after', 'shared', -50_000),
        event('log', 'tool-after', 'shared', -50_000),
        event('log', 'tool-after', 'shared', -49_000),
        event('log', 'tool-after', 'shared', -48_000),
        event('log', 'tool-after', 'shared', -47_000),
      ],
    });

    expect(snapshot.health).toBe('degraded');
    expect(snapshot.consecutiveMisses).toBe(3);
  });

  it('does not match hooks more than the grace window before their logs', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-after', 'early-1', -50_001),
        event('log', 'tool-after', 'early-1', -40_000),
        event('hook', 'tool-after', 'early-2', -40_001),
        event('log', 'tool-after', 'early-2', -30_000),
        event('hook', 'tool-after', 'early-3', -30_001),
        event('log', 'tool-after', 'early-3', -20_000),
      ],
    });

    expect(snapshot.health).toBe('degraded');
    expect(snapshot.consecutiveMisses).toBe(3);
  });

  it('matches hooks at the exact grace boundary in either direction', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-after', 'before', -70_000),
        event('log', 'tool-after', 'before', -60_000),
        event('log', 'tool-after', 'after', -30_000),
        event('hook', 'tool-after', 'after', -20_000),
      ],
    });

    expect(snapshot.health).toBe('healthy');
    expect(snapshot.consecutiveMatches).toBe(2);
    expect(snapshot.waitingForCorrelation).toBe(0);
  });

  it('recovers from degraded after two consecutive matches', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('log', 'tool-after', 'miss-1', -80_000),
        event('log', 'tool-after', 'miss-2', -70_000),
        event('log', 'tool-after', 'miss-3', -60_000),
        ...matched('recover-1', -40_000),
        ...matched('recover-2', -20_000),
      ],
    });

    expect(snapshot.health).toBe('healthy');
    expect(snapshot.consecutiveMatches).toBe(2);
  });

  it('distinguishes hook-only and log-only collection', () => {
    expect(deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [event('hook', 'tool-after', 'h', -1)],
    }).health).toBe('hook-only');

    expect(deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [event('log', 'tool-after', 'l', -1)],
    }).health).toBe('log-only');
  });

  it('does not degrade solely because SessionEnd is absent', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'session-start', null, -30_000),
        ...matched('call', -20_000),
      ],
    });

    expect(snapshot.health).toBe('healthy');
  });

  it('reports unavailable only from explicit source availability', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [],
      sourceAvailability: { hook: false, log: false },
    });

    expect(snapshot.health).toBe('unavailable');
  });

  it('reports unavailable without throwing when now cannot be evaluated', () => {
    const snapshot = deriveCollectionHealth({
      now: 'not-a-date',
      observations: [event('log', 'tool-after', 'mature-if-now-were-valid', -20_000)],
    });

    expect(snapshot).toMatchObject({
      health: 'unavailable',
      hookObserved: false,
      logObserved: true,
      consecutiveMisses: 0,
      consecutiveMatches: 0,
      waitingForCorrelation: 0,
    });
  });

  it('matches a hook tool-before to a log tool-after sharing the correlation key', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-before', 'before-only', -20_000),
        event('log', 'tool-after', 'before-only', -19_999),
      ],
    });

    expect(snapshot.health).toBe('healthy');
    expect(snapshot.consecutiveMisses).toBe(0);
  });

  it('recovers from degraded when only tool-before hooks are emitted', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('log', 'tool-after', 'miss-1', -80_000),
        event('log', 'tool-after', 'miss-2', -70_000),
        event('log', 'tool-after', 'miss-3', -60_000),
        event('hook', 'tool-before', 'recover-1', -40_000),
        event('log', 'tool-after', 'recover-1', -39_999),
        event('hook', 'tool-before', 'recover-2', -20_000),
        event('log', 'tool-after', 'recover-2', -19_999),
      ],
    });

    expect(snapshot.health).not.toBe('degraded');
  });

  it('still counts a log tool-after with no matching hook as a miss once coverage exists', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        ...matched('coverage', -90_000),
        event('log', 'tool-after', 'no-hook-1', -40_000),
        event('log', 'tool-after', 'no-hook-2', -30_000),
        event('log', 'tool-after', 'no-hook-3', -20_000),
      ],
    });

    expect(snapshot.health).toBe('degraded');
    expect(snapshot.consecutiveMisses).toBe(3);
  });

  it('does not degrade a client whose tool-phase hooks were never observed', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('log', 'tool-after', 'no-hook-1', -40_000),
        event('log', 'tool-after', 'no-hook-2', -30_000),
        event('log', 'tool-after', 'no-hook-3', -20_000),
      ],
    });

    expect(snapshot.health).toBe('log-only');
    expect(snapshot.toolHookCoverageObserved).toBe(false);
    // 진단 값으로서의 miss 계수는 그대로 보존한다
    expect(snapshot.consecutiveMisses).toBe(3);
  });

  it('treats lifecycle-only hooks as no tool coverage and reports log-only', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'session-start', null, -90_000),
        event('hook', 'turn-stop', null, -85_000),
        event('log', 'tool-after', 'no-hook-1', -40_000),
        event('log', 'tool-after', 'no-hook-2', -30_000),
        event('log', 'tool-after', 'no-hook-3', -20_000),
      ],
    });

    // 라이프사이클 hook은 툴 상관 커버리지의 근거가 아니다 —
    // healthy로 표기하면 hook+로그 양쪽 정상이라는 거짓 정보가 된다.
    expect(snapshot.health).toBe('log-only');
    expect(snapshot.toolHookCoverageObserved).toBe(false);
    expect(snapshot.hookObserved).toBe(true);
  });

  it('still degrades when tool-phase hooks stop after having worked', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-before', 'worked', -90_000),
        event('log', 'tool-after', 'worked', -89_999),
        event('log', 'tool-after', 'broke-1', -40_000),
        event('log', 'tool-after', 'broke-2', -30_000),
        event('log', 'tool-after', 'broke-3', -20_000),
      ],
    });

    // 진짜 회귀(돌던 수집기가 멈춤)는 여전히 잡아야 한다
    expect(snapshot.health).toBe('degraded');
    expect(snapshot.toolHookCoverageObserved).toBe(true);
  });

  it('aggregates equal-timestamp outcomes independently of caller order', () => {
    const misses = [
      event('log', 'tool-after', 'miss-1', -20_000),
      event('log', 'tool-after', 'miss-2', -20_000),
      event('log', 'tool-after', 'miss-3', -20_000),
    ];
    const matches = [
      event('hook', 'tool-after', 'match-1', -20_000),
      event('log', 'tool-after', 'match-1', -20_000),
      event('hook', 'tool-after', 'match-2', -20_000),
      event('log', 'tool-after', 'match-2', -20_000),
    ];

    const missesFirst = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [...misses, ...matches],
    });
    const matchesFirst = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [...matches, ...misses],
    });

    expect(matchesFirst).toEqual(missesFirst);
    expect(matchesFirst.health).toBe('healthy');
    expect(matchesFirst.consecutiveMatches).toBe(2);
  });

  it('does not degrade on log completions that precede hook coverage', () => {
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        // 훅을 켜기 전에 쌓인 과거 이력 — 짝이 없는 것이 당연하다
        event('log', 'tool-after', 'legacy-1', -90_000),
        event('log', 'tool-after', 'legacy-2', -80_000),
        event('log', 'tool-after', 'legacy-3', -70_000),
        // 그 뒤에 훅이 처음 붙었다
        event('hook', 'tool-before', 'after-install', -20_000),
        event('log', 'tool-after', 'after-install', -19_999),
      ],
    });

    expect(snapshot.health).not.toBe('degraded');
    expect(snapshot.toolHookCoverageObserved).toBe(true);
    // 진단 값으로서의 miss 계수는 보존한다
    expect(snapshot.consecutiveMisses).toBe(0);   // 마지막이 매치라 연속 miss는 끊긴다
  });

  it('degrades only on misses at or after the coverage instant', () => {
    const before = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('log', 'tool-after', 'legacy-1', -90_000),
        event('log', 'tool-after', 'legacy-2', -80_000),
        event('log', 'tool-after', 'legacy-3', -70_000),
        event('hook', 'tool-before', 'coverage', -60_000),
      ],
    });
    expect(before.health).not.toBe('degraded');

    const after = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-before', 'coverage', -60_000),
        event('log', 'tool-after', 'gone-1', -50_000),
        event('log', 'tool-after', 'gone-2', -40_000),
        event('log', 'tool-after', 'gone-3', -30_000),
      ],
    });
    expect(after.health).toBe('degraded');
  });

  it('counts a miss at the exact coverage instant toward degrading', () => {
    // 동시각 배치는 한 논리 단위다 — 커버리지와 같은 순간의 miss는 승격 대상이다.
    const snapshot = deriveCollectionHealth({
      now: new Date(NOW).toISOString(),
      observations: [
        event('hook', 'tool-before', 'coverage', -20_000),
        event('log', 'tool-after', 'miss-1', -20_000),
        event('log', 'tool-after', 'miss-2', -20_000),
        event('log', 'tool-after', 'miss-3', -20_000),
      ],
    });

    expect(snapshot.health).toBe('degraded');
  });
});
