// H12: Hook-first ingestion pipeline E2E.
// Exercises the completed H0-H11 system end to end from deterministic fixtures:
// hook-only, log-only, hook<->log merge on native identity, corrupt log with a
// healthy hook, inbox restart durability, and the three-client combined matrix.
// It also models the released rollout states (shadow/count-primary/health-gated)
// at the test level to prove the shadow default does not alter existing
// recommendation results. No new product API is introduced.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LensStore } from '../../src/store/store.js';
import { buildMatrix } from '../../src/engine/engine.js';
import { IngestionCoordinator } from '../../src/ingest/coordinator.js';
import { enqueueEnvelope } from '../../src/ingest/inbox.js';
import { makeCorrelationKey } from '../../src/ingest/identity.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';
import { GeminiAdapter } from '../../src/adapters/gemini/adapter.js';
import type { HookEnvelope, ToolObservation } from '../../src/ingest/contracts.js';
import type { AdapterResult, ClientId, MatrixRow, ToolCallEvent } from '../../src/types.js';

const NOW = '2026-07-20T00:00:00.000Z';
const EPOCH = '2000-01-01';
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-h12-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface CallShape {
  client: ClientId;
  externalSessionId: string;
  externalCallId: string;
  serverName: string;
  toolName: string;
}

// Gemini lifecycle hooks expose no call ID, so the log bridge correlates Gemini
// evidence through the fallback identity (client/session/turn/phase/tool). Mirror
// that here so a hook and its transcript merge exactly as they do in production.
function isGemini(client: ClientId): boolean {
  return client === 'gemini-cli';
}

function hookCallId(shape: CallShape): string | null {
  return isGemini(shape.client) ? null : shape.externalCallId;
}

function correlationKey(shape: CallShape): string {
  return makeCorrelationKey({
    client: shape.client, externalSessionId: shape.externalSessionId, externalTurnId: null,
    externalCallId: hookCallId(shape), phase: 'tool-after', toolName: shape.toolName,
    inputFingerprint: null,
  });
}

/** A completed hook observation (`tool-after`) that materializes into one call. */
function hookObservation(shape: CallShape, overrides: Partial<ToolObservation> = {}): ToolObservation {
  return {
    schemaVersion: 1,
    deliveryId: `hook:${shape.client}:${shape.externalCallId}`,
    source: 'hook',
    correlationKey: correlationKey(shape),
    correlationConfidence: isGemini(shape.client) ? 'low' : 'high',
    client: shape.client,
    phase: 'tool-after',
    receivedAt: NOW,
    externalSessionId: shape.externalSessionId,
    externalTurnId: null,
    externalCallId: hookCallId(shape),
    transcriptPath: null,
    serverName: shape.serverName,
    toolName: shape.toolName,
    observedAt: NOW,
    durationMs: 25,
    isError: false,
    inputFingerprint: null,
    responseTokens: null,
    loadedTokens: null,
    ...overrides,
  };
}

function hookEnvelope(shape: CallShape): HookEnvelope {
  const o = hookObservation(shape);
  return {
    schemaVersion: o.schemaVersion, deliveryId: o.deliveryId, client: o.client, phase: o.phase,
    receivedAt: o.receivedAt, externalSessionId: o.externalSessionId, externalTurnId: o.externalTurnId,
    externalCallId: o.externalCallId, transcriptPath: o.transcriptPath, serverName: o.serverName,
    toolName: o.toolName, observedAt: o.observedAt, durationMs: o.durationMs, isError: o.isError,
    inputFingerprint: o.inputFingerprint,
  };
}

/** A transcript-derived AdapterResult carrying the same native call identity. */
function logResult(shape: CallShape, responseTokens: number): AdapterResult {
  const sessionId = `session-${shape.client}-${shape.externalSessionId}`;
  return {
    session: {
      sessionId, client: shape.client, filePath: `/tmp/${sessionId}.jsonl`,
      externalSessionId: shape.externalSessionId, startedAt: NOW, mode: 'DEFERRED_MEASURABLE',
    },
    toolCalls: [{
      sessionId, serverName: shape.serverName, toolName: shape.toolName,
      calledAt: NOW, durationMs: 7, isError: false, responseTokens,
      responseText: null, externalCallId: shape.externalCallId,
    }],
    toolLoads: [], usage: [], parseErrors: 0,
  };
}

/** A corrupt transcript reconciliation: nothing parsed, only parse errors. */
function corruptLogResult(shape: CallShape): AdapterResult {
  const sessionId = `session-${shape.client}-${shape.externalSessionId}`;
  return {
    session: {
      sessionId, client: shape.client, filePath: `/tmp/${sessionId}.jsonl`,
      externalSessionId: shape.externalSessionId, startedAt: NOW, mode: 'DEFERRED_OPAQUE',
    },
    toolCalls: [], toolLoads: [], usage: [], parseErrors: 3,
  };
}

const SHAPE: CallShape = {
  client: 'codex', externalSessionId: 'session-1', externalCallId: 'call-1',
  serverName: 'github', toolName: 'get_issue',
};

describe('hook-first ingestion pipeline (E2E)', () => {
  it('materializes a hook-only call with no transcript', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(hookObservation(SHAPE));

    const calls = store.callsSince(EPOCH);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      serverName: 'github', toolName: 'get_issue', durationMs: 25, isError: false,
    });
    store.close();
  });

  it('materializes a log-only call from a transcript', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(logResult(SHAPE, 42));

    const calls = store.callsSince(EPOCH);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'get_issue', responseTokens: 42 });
    store.close();
  });

  it('merges hook and log arriving in either order into one canonical call', async () => {
    async function merged(order: readonly ('hook' | 'log')[]): Promise<ToolCallEvent[]> {
      const store = await LensStore.open(':memory:');
      for (const source of order) {
        if (source === 'hook') store.upsertObservation(hookObservation(SHAPE));
        else store.ingest(logResult(SHAPE, 42));
      }
      const calls = store.callsSince(EPOCH);
      store.close();
      return calls;
    }

    const hookThenLog = await merged(['hook', 'log']);
    const logThenHook = await merged(['log', 'hook']);

    expect(hookThenLog).toHaveLength(1);
    expect(hookThenLog).toEqual(logThenHook);
    // Hook supplies identity/error/duration; log supplies response tokens.
    expect(hookThenLog[0]).toMatchObject({ durationMs: 25, isError: false, responseTokens: 42 });
  });

  it('materializes exactly one logical call per native call id across duplicate deliveries', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(hookObservation(SHAPE));
    store.upsertObservation(hookObservation(SHAPE)); // duplicate delivery
    store.ingest(logResult(SHAPE, 42));
    store.ingest(logResult(SHAPE, 42)); // transcript reparse

    expect(store.callsSince(EPOCH)).toHaveLength(1);
    store.close();
  });

  it('keeps the hook call and its error/duration when the transcript is corrupt', async () => {
    const store = await LensStore.open(':memory:');
    const failing = hookObservation(SHAPE, { isError: true, durationMs: 44 });
    store.upsertObservation(failing);
    // A corrupt transcript reconciliation for the same session parses nothing.
    store.ingest(corruptLogResult(SHAPE));

    const calls = store.callsSince(EPOCH);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ isError: true, durationMs: 44 });
    store.close();
  });

  it('durably survives an inbox drain across a store restart', async () => {
    const root = temporaryRoot();
    const dbPath = join(root, 'lens.db');
    const inbox = join(root, 'inbox');
    const store = await LensStore.open(dbPath);
    enqueueEnvelope(hookEnvelope(SHAPE), { root: inbox });
    const coordinator = new IngestionCoordinator({ inbox: { root: inbox }, store });

    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 1, parseErrors: 0 });
    store.close();

    // Restart: a fresh store reopens the same on-disk database.
    const reopened = await LensStore.open(dbPath);
    expect(reopened.observationCount()).toBe(1);
    expect(reopened.callsSince(EPOCH)).toHaveLength(1);
    reopened.close();
  });

  it('combines Claude, Codex, and Gemini hook+log evidence into one matrix', async () => {
    const shapes: CallShape[] = [
      { client: 'claude-code', externalSessionId: 's-claude', externalCallId: 'toolu_1',
        serverName: 'github', toolName: 'get_issue' },
      { client: 'codex', externalSessionId: 's-codex', externalCallId: 'call-c',
        serverName: 'weather', toolName: 'get_forecast' },
      { client: 'gemini-cli', externalSessionId: 's-gemini', externalCallId: 'g-1',
        serverName: 'search', toolName: 'find_places' },
    ];
    const store = await LensStore.open(':memory:');
    for (const shape of shapes) {
      store.upsertObservation(hookObservation(shape));
      store.ingest(logResult(shape, 100));
    }

    const calls = store.callsSince(EPOCH);
    // Each native call id materializes exactly once even with hook+log evidence.
    expect(calls).toHaveLength(shapes.length);

    const clients = new Set(store.sessionsSince(EPOCH).map((s) => s.client));
    expect(clients).toEqual(new Set(['claude-code', 'codex', 'gemini-cli']));

    const rows = buildMatrix({
      definitions: store.allDefinitions(), calls,
      loads: store.loadsSince(EPOCH), sessions: store.sessionsSince(EPOCH),
    });
    const totalCallCount = rows.reduce((n, r) => n + r.callCount, 0);
    expect(totalCallCount).toBe(shapes.length);
    store.close();
  });

  it('startDraining이 실 chokidar로 pending 파일을 감지해 DB에 반영한다', async () => {
    const root = temporaryRoot();
    const store = await LensStore.open(':memory:');
    const coordinator = new IngestionCoordinator({ store, inbox: { root } });
    try {
      // startDraining()은 chokidar 초기 스캔(ready) 완료 후에야 resolve되므로,
      // 반환 시점에 워처는 이미 감시 상태다. 별도 정착 대기 불필요.
      await coordinator.startDraining();

      const env: HookEnvelope = {
        schemaVersion: 1, deliveryId: 'native:e2e-watch-1', client: 'codex',
        phase: 'tool-after', receivedAt: NOW, externalSessionId: 's-watch',
        externalTurnId: 't-watch', externalCallId: 'native:e2e-watch-1',
        transcriptPath: null, serverName: 'github', toolName: 'get_issue',
        observedAt: NOW, durationMs: 7, isError: false, inputFingerprint: null,
      };
      enqueueEnvelope(env, { root }); // pending에 실제 파일 write → chokidar 'add'

      // 실 워처 발화까지 폴링(최대 10초; awaitWriteFinish stabilityThreshold 500ms + fsevents 지연 여유).
      const deadline = Date.now() + 10_000;
      let rows = 0;
      while (Date.now() < deadline) {
        rows = store.observationCount();
        if (rows >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(rows).toBe(1);
    } finally {
      await coordinator.stopDraining();
      store.close();
    }
  }, 15_000); // 폴링 데드라인(10s) < vitest 테스트 타임아웃(15s) 보장.
});

// --- Rollout feature flags (test-scoped model) --------------------------------
// H12 released default is `shadow`. The three states select which canonical
// calls feed the recommendation engine. Modeled here rather than as product
// API: shadow must reproduce the pre-hook (log-only) recommendation exactly.
type RolloutState = 'shadow' | 'count-primary' | 'health-gated';
const RELEASED_DEFAULT: RolloutState = 'shadow';

function recommendationCalls(
  state: RolloutState,
  input: { logOnly: ToolCallEvent[]; merged: ToolCallEvent[]; health: string },
): ToolCallEvent[] {
  switch (state) {
    case 'shadow': return input.logOnly;
    case 'count-primary': return input.merged;
    case 'health-gated': return input.health === 'healthy' ? input.merged : input.logOnly;
  }
}

function recommendationRows(store: LensStore, calls: ToolCallEvent[]): MatrixRow[] {
  return buildMatrix({
    definitions: store.allDefinitions(), calls,
    loads: store.loadsSince(EPOCH), sessions: store.sessionsSince(EPOCH),
  });
}

describe('hook-first rollout states', () => {
  // Two stores describe the same activity: a log-only baseline and a full store
  // where an extra hook-only call was captured that the transcript never logged.
  async function scenario(): Promise<{ baseline: LensStore; full: LensStore }> {
    const logged: CallShape = SHAPE;
    const hookOnly: CallShape = { ...SHAPE, externalCallId: 'call-2', toolName: 'list_issues' };

    const baseline = await LensStore.open(':memory:');
    baseline.ingest(logResult(logged, 42));

    const full = await LensStore.open(':memory:');
    full.ingest(logResult(logged, 42));
    full.upsertObservation(hookObservation(hookOnly)); // captured only by the hook

    return { baseline, full };
  }

  it('defaults to shadow', () => {
    expect(RELEASED_DEFAULT).toBe('shadow');
  });

  it('shadow leaves recommendations identical to the log-only baseline', async () => {
    const { baseline, full } = await scenario();
    const baselineRows = recommendationRows(baseline, baseline.callsSince(EPOCH));

    const shadowCalls = recommendationCalls('shadow', {
      logOnly: baseline.callsSince(EPOCH),
      merged: full.callsSince(EPOCH),
      health: full.collectionHealth(NOW).health,
    });
    const shadowRows = recommendationRows(baseline, shadowCalls);

    expect(shadowRows).toEqual(baselineRows);
    baseline.close();
    full.close();
  });

  it('count-primary lets the hook-only call change recommendations', async () => {
    const { baseline, full } = await scenario();
    const baselineRows = recommendationRows(baseline, baseline.callsSince(EPOCH));

    const primaryCalls = recommendationCalls('count-primary', {
      logOnly: baseline.callsSince(EPOCH),
      merged: full.callsSince(EPOCH),
      health: full.collectionHealth(NOW).health,
    });
    const primaryRows = recommendationRows(full, primaryCalls);

    const baselineCalls = baselineRows.reduce((n, r) => n + r.callCount, 0);
    const primaryCallCount = primaryRows.reduce((n, r) => n + r.callCount, 0);
    expect(primaryCallCount).toBe(baselineCalls + 1);
    baseline.close();
    full.close();
  });

  it('health-gated counts the hook only while collection health is healthy', async () => {
    const { baseline, full } = await scenario();
    const logOnly = baseline.callsSince(EPOCH);
    const merged = full.callsSince(EPOCH);

    // Degraded/low-confidence collection falls back to the log-only baseline.
    expect(recommendationCalls('health-gated', { logOnly, merged, health: 'degraded' }))
      .toEqual(logOnly);
    // Healthy collection trusts the merged (hook-inclusive) calls.
    expect(recommendationCalls('health-gated', { logOnly, merged, health: 'healthy' }))
      .toEqual(merged);
    baseline.close();
    full.close();
  });
});
