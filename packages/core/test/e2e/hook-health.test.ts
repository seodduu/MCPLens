// H12: Collection-health E2E over the completed H0-H11 system.
// Drives the health state machine through the concrete LensStore (hook/log
// observations) and verifies the recommendation gate reacts to the derived
// health. Deterministic clock and :memory: DB only. No new product API.
import { describe, expect, it } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import { gateRecommendation } from '../../src/engine/healthGate.js';
import { makeCorrelationKey } from '../../src/ingest/identity.js';
import type { ToolObservation } from '../../src/ingest/contracts.js';
import type { AdapterResult, ClientId, Recommendation } from '../../src/types.js';

const T0 = Date.parse('2026-07-20T00:00:00.000Z');
const NOW = '2026-07-20T00:01:00.000Z'; // 60s after T0 → well past the 10s grace
const EPOCH = '2000-01-01';

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function hookObservation(
  client: ClientId, externalSessionId: string, externalCallId: string,
  toolName: string, observedAt: string, overrides: Partial<ToolObservation> = {},
): ToolObservation {
  return {
    schemaVersion: 1,
    deliveryId: `hook:${externalCallId}:${observedAt}`,
    source: 'hook',
    correlationKey: makeCorrelationKey({
      client, externalSessionId, externalTurnId: null, externalCallId,
      phase: 'tool-after', toolName, inputFingerprint: null,
    }),
    correlationConfidence: 'high',
    client, phase: 'tool-after', receivedAt: observedAt,
    externalSessionId, externalTurnId: null, externalCallId, transcriptPath: null,
    serverName: 'github', toolName, observedAt, durationMs: 25, isError: false,
    inputFingerprint: null, responseTokens: null, loadedTokens: null,
    ...overrides,
  };
}

interface LogCall { externalCallId: string; toolName: string; calledAt: string; }

function logResult(client: ClientId, externalSessionId: string, calls: readonly LogCall[]): AdapterResult {
  const sessionId = `session-${client}-${externalSessionId}`;
  return {
    session: {
      sessionId, client, filePath: `/tmp/${sessionId}.jsonl`,
      externalSessionId, startedAt: at(0), mode: 'DEFERRED_MEASURABLE',
    },
    toolCalls: calls.map((call) => ({
      sessionId, serverName: 'github', toolName: call.toolName, calledAt: call.calledAt,
      durationMs: 7, isError: false, responseTokens: 42, responseText: null,
      externalCallId: call.externalCallId,
    })),
    toolLoads: [], usage: [], parseErrors: 0,
  };
}

function corruptLogResult(client: ClientId, externalSessionId: string): AdapterResult {
  const sessionId = `session-${client}-${externalSessionId}`;
  return {
    session: {
      sessionId, client, filePath: `/tmp/${sessionId}.jsonl`,
      externalSessionId, startedAt: at(0), mode: 'DEFERRED_OPAQUE',
    },
    toolCalls: [], toolLoads: [], usage: [], parseErrors: 3,
  };
}

function removeRecommendation(): Recommendation {
  return {
    action: 'remove',
    confidence: 'high',
    reason: '정의 900토큰, 호출 0회; 제거 시 매 세션 약 900토큰 절약',
    reasonParts: {
      basis: '정의 900토큰, 호출 0회',
      serverBasis: null,
      effect: '제거 시 매 세션 약 900토큰 절약',
      caveat: null,
    },
    evidenceLabel: '실측',
    evidence: {
      observedSessions: 4, datedObservedSessions: 4, observedDays: 3,
      lastCalledAt: null, costPerSession: 900, totalObservedCost: 3600,
    },
  };
}

describe('collection health (E2E)', () => {
  it('is idle on an empty store', async () => {
    const store = await LensStore.open(':memory:');
    expect(store.collectionHealth(NOW).health).toBe('idle');
    store.close();
  });

  it('reports hook-only after a hook observation with no transcript', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(hookObservation('codex', 's1', 'c1', 'get_issue', at(30_000)));
    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'hook-only', hookObserved: true, logObserved: false,
    });
    store.close();
  });

  it('reports log-only after a transcript with no hook', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(logResult('codex', 's1', [{ externalCallId: 'c1', toolName: 'get_issue', calledAt: at(55_000) }]));
    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'log-only', hookObserved: false, logObserved: true,
    });
    store.close();
  });

  it('reports healthy when a hook and its transcript correlate', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(hookObservation('codex', 's1', 'c1', 'get_issue', at(55_000)));
    store.ingest(logResult('codex', 's1', [{ externalCallId: 'c1', toolName: 'get_issue', calledAt: at(55_000) }]));
    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'healthy', hookObserved: true, logObserved: true,
      consecutiveMatches: 1, waitingForCorrelation: 0,
    });
    store.close();
  });

  it('degrades after three matured correlation misses', async () => {
    const store = await LensStore.open(':memory:');
    // Three completed transcript calls at T0 with no correlating hook; NOW is
    // 60s later so every miss has matured past the grace window.
    store.ingest(logResult('codex', 's1', [
      { externalCallId: 'm1', toolName: 'a', calledAt: at(0) },
      { externalCallId: 'm2', toolName: 'b', calledAt: at(0) },
      { externalCallId: 'm3', toolName: 'c', calledAt: at(0) },
    ]));
    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'degraded', consecutiveMisses: 3,
    });
    store.close();
  });

  it('recovers to healthy after two matches follow the degrade', async () => {
    const store = await LensStore.open(':memory:');
    // One transcript batch: three early misses, then two later calls that a hook
    // corroborates. Later matches follow the misses in time order.
    store.ingest(logResult('codex', 's1', [
      { externalCallId: 'm1', toolName: 'a', calledAt: at(0) },
      { externalCallId: 'm2', toolName: 'b', calledAt: at(0) },
      { externalCallId: 'm3', toolName: 'c', calledAt: at(0) },
      { externalCallId: 'r1', toolName: 'd', calledAt: at(30_000) },
      { externalCallId: 'r2', toolName: 'e', calledAt: at(40_000) },
    ]));
    store.upsertObservation(hookObservation('codex', 's1', 'r1', 'd', at(30_000)));
    store.upsertObservation(hookObservation('codex', 's1', 'r2', 'e', at(40_000)));

    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'healthy', consecutiveMatches: 2, consecutiveMisses: 0,
    });
    store.close();
  });

  it('keeps the hook call and hook-only health when the transcript is corrupt', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(hookObservation('codex', 's1', 'c1', 'get_issue', at(55_000)));
    store.ingest(corruptLogResult('codex', 's1'));

    expect(store.callsSince(EPOCH)).toHaveLength(1);
    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'hook-only', hookObserved: true, logObserved: false,
    });
    store.close();
  });
});

describe('recommendation gate reacts to collection health (E2E)', () => {
  async function healthOf(build: (store: LensStore) => void): Promise<LensStore> {
    const store = await LensStore.open(':memory:');
    build(store);
    return store;
  }

  it('passes a destructive recommendation through under healthy collection', async () => {
    const store = await healthOf((s) => {
      s.upsertObservation(hookObservation('codex', 's1', 'c1', 'get_issue', at(55_000)));
      s.ingest(logResult('codex', 's1', [{ externalCallId: 'c1', toolName: 'get_issue', calledAt: at(55_000) }]));
    });
    const health = store.collectionHealth(NOW);
    expect(health.health).toBe('healthy');
    expect(gateRecommendation(removeRecommendation(), health)).toEqual(removeRecommendation());
    store.close();
  });

  it('downgrades a destructive recommendation to low confidence under degraded collection', async () => {
    const store = await healthOf((s) => {
      s.ingest(logResult('codex', 's1', [
        { externalCallId: 'm1', toolName: 'a', calledAt: at(0) },
        { externalCallId: 'm2', toolName: 'b', calledAt: at(0) },
        { externalCallId: 'm3', toolName: 'c', calledAt: at(0) },
      ]));
    });
    const health = store.collectionHealth(NOW);
    expect(health.health).toBe('degraded');

    const gated = gateRecommendation(removeRecommendation(), health);
    expect(gated.action).toBe('remove'); // action is preserved
    expect(gated.confidence).toBe('low');
    expect(gated.reasonParts.caveat).toContain('수집 건강도 낮음');
    store.close();
  });

  it('marks tokens unmeasurable under hook-only collection', async () => {
    const store = await healthOf((s) => {
      s.upsertObservation(hookObservation('codex', 's1', 'c1', 'get_issue', at(55_000)));
    });
    const health = store.collectionHealth(NOW);
    expect(health.health).toBe('hook-only');

    const gated = gateRecommendation(removeRecommendation(), health);
    expect(gated.evidenceLabel).toBe('측정 불가');
    expect(gated.evidence.costPerSession).toBeNull();
    expect(gated.reasonParts.effect).toContain('토큰 측정 불가');
    store.close();
  });
});
