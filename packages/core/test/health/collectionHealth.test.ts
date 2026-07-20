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
});
