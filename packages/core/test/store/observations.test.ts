import { afterEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';
import { GeminiAdapter } from '../../src/adapters/gemini/adapter.js';
import { IngestionCoordinator } from '../../src/ingest/coordinator.js';
import { enqueueEnvelope } from '../../src/ingest/inbox.js';
import { LensStore } from '../../src/store/store.js';
import { materializeSession } from '../../src/store/observations.js';
import { makeCorrelationKey } from '../../src/ingest/identity.js';
import { CORRELATION_GRACE_MS } from '../../src/health/collectionHealth.js';
import { buildMatrix, visibleMatrixRows } from '../../src/engine/engine.js';
import type { HookEnvelope, ToolObservation } from '../../src/ingest/contracts.js';
import type { AdapterResult, ClientId, GlobalAction, ToolDefinition } from '../../src/types.js';
import type {
  CollectionHealthInput,
  CollectionHealthSnapshot,
  IngestionCoordinatorOptions,
  IngestionResult,
} from '../../src/index.js';

const NOW = '2026-07-20T00:00:00.000Z';
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-h8-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function observation(overrides: Partial<ToolObservation> = {}): ToolObservation {
  return {
    schemaVersion: 1,
    deliveryId: 'delivery-hook',
    source: 'hook',
    correlationKey: makeCorrelationKey({
      client: 'codex', externalSessionId: 'external-session-1', externalTurnId: null,
      externalCallId: 'call-1', phase: 'tool-after', toolName: 'get_issue', inputFingerprint: null,
    }),
    correlationConfidence: 'high',
    client: 'codex',
    phase: 'tool-after',
    receivedAt: NOW,
    externalSessionId: 'external-session-1',
    externalTurnId: null,
    externalCallId: 'call-1',
    transcriptPath: null,
    serverName: 'github',
    toolName: 'get_issue',
    observedAt: NOW,
    durationMs: 25,
    isError: false,
    inputFingerprint: null,
    responseTokens: null,
    loadedTokens: null,
    ...overrides,
  };
}

function hookEnvelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  const base = observation(overrides as Partial<ToolObservation>);
  return {
    schemaVersion: base.schemaVersion,
    deliveryId: base.deliveryId,
    client: base.client,
    phase: base.phase,
    receivedAt: base.receivedAt,
    externalSessionId: base.externalSessionId,
    externalTurnId: base.externalTurnId,
    externalCallId: base.externalCallId,
    transcriptPath: base.transcriptPath,
    serverName: base.serverName,
    toolName: base.toolName,
    observedAt: base.observedAt,
    durationMs: base.durationMs,
    isError: base.isError,
    inputFingerprint: base.inputFingerprint,
  };
}

function legacyResult(): AdapterResult {
  return {
    session: {
      sessionId: 'legacy-session-1', client: 'codex', filePath: '/tmp/session.jsonl',
      externalSessionId: 'external-session-1', startedAt: NOW, mode: 'DEFERRED_MEASURABLE',
    },
    toolCalls: [{
      sessionId: 'legacy-session-1', serverName: 'github', toolName: 'get_issue',
      calledAt: NOW, durationMs: 7, isError: false, responseTokens: 42,
      responseText: null, externalCallId: 'call-1',
    }],
    toolLoads: [], usage: [], parseErrors: 0,
  };
}

function exactCodexLoad(exposedToolName: string): AdapterResult {
  return {
    session: {
      sessionId: 'codex-exact-load-session', client: 'codex', filePath: '/tmp/codex-exact.jsonl',
      externalSessionId: 'codex-exact-load-external', startedAt: NOW, mode: 'DEFERRED_MEASURABLE',
    },
    toolCalls: [],
    toolLoads: [{
      sessionId: 'codex-exact-load-session', serverName: null,
      toolName: exposedToolName, loadedTokens: 37,
    }],
    usage: [], parseErrors: 0,
  };
}

const codexAction = (overrides: Partial<GlobalAction> = {}): GlobalAction => ({
  actionId: 'codex-exact-action', client: 'codex', serverName: 'atlas', toolName: 'lookup',
  identityHash: 'identity-anon', definitionSetHash: 'definitions-anon',
  ownedRule: 'atlas_lookup', backupPath: '/tmp/backup-anon', preFingerprint: 'before-anon',
  postFingerprint: 'after-anon', status: 'active', createdAt: '2026-07-19T00:00:00.000Z',
  restoredAt: null, ...overrides,
});

const definition = (serverName: string, toolName: string): ToolDefinition => ({
  serverName, toolName, definitionTokens: 100, advertisedTokens: null, nameListTokens: null, estimatorVersion: 'v1',
  scannedAt: NOW, firstScannedAt: NOW,
});

function visibleActionCandidates(store: LensStore) {
  const sessions = store.sessionsSince('2000-01-01');
  return visibleMatrixRows(buildMatrix({
    definitions: store.allDefinitions(), calls: store.callsSince('2000-01-01'),
    loads: store.loadsSince('2000-01-01'), sessions,
  }), sessions).filter((row) => row.recommendation.action === 'remove'
    || row.recommendation.action === 'filter-server');
}

async function canonicalCalls(order: readonly ('hook' | 'log')[]) {
  const store = await LensStore.open(':memory:');
  for (const source of order) {
    if (source === 'hook') store.upsertObservation(observation());
    else store.ingest(legacyResult());
  }
  return store.callsSince('2000-01-01');
}

function resultForSession(
  sessionId: string,
  externalSessionId: string | null,
  toolName: string,
  responseTokens: number,
): AdapterResult {
  const result = legacyResult();
  result.session = { ...result.session, sessionId, externalSessionId };
  result.toolCalls = [{
    ...result.toolCalls[0]!,
    sessionId,
    toolName,
    responseTokens,
  }];
  return result;
}

function logLoad(deliveryId: string, loadedTokens: number): ToolObservation {
  const before = observation({
    deliveryId,
    source: 'log',
    phase: 'tool-before',
    externalCallId: null,
    durationMs: null,
    isError: null,
    responseTokens: null,
    loadedTokens,
  });
  return {
    ...before,
    correlationKey: makeCorrelationKey({
      client: before.client,
      externalSessionId: before.externalSessionId,
      externalTurnId: before.externalTurnId,
      externalCallId: before.externalCallId,
      phase: before.phase,
      toolName: before.toolName,
      inputFingerprint: before.inputFingerprint,
    }),
  };
}

function logCall(deliveryId: string, responseTokens: number): ToolObservation {
  const completed = observation({
    deliveryId,
    source: 'log',
    externalCallId: null,
    durationMs: 7,
    responseTokens,
  });
  return {
    ...completed,
    correlationKey: makeCorrelationKey({
      client: completed.client,
      externalSessionId: completed.externalSessionId,
      externalTurnId: completed.externalTurnId,
      externalCallId: completed.externalCallId,
      phase: completed.phase,
      toolName: completed.toolName,
      inputFingerprint: completed.inputFingerprint,
    }),
  };
}

function observedAt(offsetMs: number): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

function fallbackCompleted(
  deliveryId: string,
  source: 'hook' | 'log',
  offsetMs: number,
  overrides: Partial<ToolObservation> = {},
): ToolObservation {
  const completed = observation({
    deliveryId,
    source,
    correlationConfidence: source === 'hook' ? 'medium' : 'low',
    observedAt: observedAt(offsetMs),
    externalCallId: null,
    durationMs: source === 'hook' ? offsetMs + 10 : 7,
    responseTokens: source === 'log' ? offsetMs + 100 : null,
    ...overrides,
  });
  return { ...completed, correlationKey: makeCorrelationKey(completed) };
}

describe('observation materialization', () => {
  it('returns dependency calls in stable session, time, and database-id order without dropping null times', async () => {
    const path = join(temporaryRoot(), 'dependency-calls.db');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, client TEXT NOT NULL,
      file_path TEXT, external_session_id TEXT, started_at TEXT, mode TEXT NOT NULL);
      CREATE TABLE tool_definitions (server_name TEXT NOT NULL, tool_name TEXT NOT NULL,
      definition_tokens INTEGER NOT NULL, scanned_at TEXT NOT NULL, first_scanned_at TEXT,
      PRIMARY KEY(server_name, tool_name));
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL, called_at TEXT, duration_ms INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0, response_tokens INTEGER);
      INSERT INTO tool_calls(session_id,server_name,tool_name,called_at,is_error) VALUES
        ('session-b','github','same-time-first','${NOW}',0),
        ('session-b','github','same-time-second','${NOW}',0),
        ('session-b','github','unknown-time',NULL,0),
        ('session-a','github','early','${observedAt(-1)}',0);`);
    writeFileSync(path, Buffer.from(db.export()));
    db.close();
    const store = await LensStore.open(path);

    expect(store.dependencyCallsSince(observedAt(-2))).toEqual([
      { sequence: expect.any(Number), sessionId: 'session-a', serverName: 'github',
        toolName: 'early', calledAt: observedAt(-1), isError: false },
      { sequence: expect.any(Number), sessionId: 'session-b', serverName: 'github',
        toolName: 'unknown-time', calledAt: null, isError: false },
      { sequence: expect.any(Number), sessionId: 'session-b', serverName: 'github',
        toolName: 'same-time-first', calledAt: NOW, isError: false },
      { sequence: expect.any(Number), sessionId: 'session-b', serverName: 'github',
        toolName: 'same-time-second', calledAt: NOW, isError: false },
    ]);
    store.close();
  });

  it('materializes hook and log observations identically regardless of arrival order', async () => {
    const hookThenLog = await canonicalCalls(['hook', 'log']);
    const logThenHook = await canonicalCalls(['log', 'hook']);

    expect(hookThenLog).toEqual(logThenHook);
    expect(hookThenLog).toMatchObject([{
      serverName: 'github', toolName: 'get_issue', durationMs: 25,
      isError: false, responseTokens: 42,
    }]);
  });

  it('keeps duplicate delivery ids to one materialized call', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(observation());
    store.upsertObservation(observation());

    expect(store.observationCount()).toBe(1);
    expect(store.callsSince('2000-01-01')).toHaveLength(1);
  });

  it('preserves legacy call cardinality when fallback correlation identities collide', async () => {
    const store = await LensStore.open(':memory:');
    const result = legacyResult();
    result.toolCalls = [
      { ...result.toolCalls[0]!, externalCallId: null, responseTokens: 11 },
      { ...result.toolCalls[0]!, externalCallId: null, responseTokens: 22 },
    ];

    store.ingest(result);

    expect(store.observationsForSession(result.session.sessionId)).toHaveLength(2);
    expect(store.callsSince('2000-01-01').map((call) => call.responseTokens)).toEqual([11, 22]);
  });

  it('materializes each completed log delivery when their correlation key collides', () => {
    const result = materializeSession([
      logCall('log-call-1', 11),
      logCall('log-call-2', 22),
    ]);

    expect(result.toolCalls.map((call) => call.responseTokens)).toEqual([11, 22]);
  });

  it('pairs unequal sequences by nearest time without shifting a missing middle occurrence', () => {
    const missingLogMiddle = materializeSession([
      fallbackCompleted('hook-2', 'hook', 20),
      fallbackCompleted('log-2', 'log', 21, { responseTokens: 300 }),
      fallbackCompleted('hook-0', 'hook', 0),
      fallbackCompleted('hook-1', 'hook', 10),
      fallbackCompleted('log-0', 'log', 1, { responseTokens: 100 }),
    ]);
    expect(missingLogMiddle.toolCalls.map((call) => ({
      durationMs: call.durationMs,
      responseTokens: call.responseTokens,
    }))).toEqual([
      { durationMs: 10, responseTokens: 100 },
      { durationMs: 20, responseTokens: null },
      { durationMs: 30, responseTokens: 300 },
    ]);

    const missingHookMiddle = materializeSession([
      fallbackCompleted('log-2', 'log', 21, { responseTokens: 300 }),
      fallbackCompleted('hook-2', 'hook', 20),
      fallbackCompleted('log-1', 'log', 11, { responseTokens: 200 }),
      fallbackCompleted('log-0', 'log', 1, { responseTokens: 100 }),
      fallbackCompleted('hook-0', 'hook', 0),
    ]);
    expect(missingHookMiddle.toolCalls.map((call) => ({
      durationMs: call.durationMs,
      responseTokens: call.responseTokens,
    }))).toEqual([
      { durationMs: 10, responseTokens: 100 },
      { durationMs: 7, responseTokens: 200 },
      { durationMs: 30, responseTokens: 300 },
    ]);
  });

  it('is independent of arrival order when timestamps are skewed', () => {
    const observations = [
      fallbackCompleted('hook-late', 'hook', 100),
      fallbackCompleted('log-early', 'log', 3, { responseTokens: 103 }),
      fallbackCompleted('hook-early', 'hook', 0),
      fallbackCompleted('log-late', 'log', 107, { responseTokens: 207 }),
    ];

    expect(materializeSession(observations)).toEqual(materializeSession([...observations].reverse()));
    expect(materializeSession(observations).toolCalls.map((call) => call.responseTokens))
      .toEqual([103, 207]);
  });

  it('orders more than ten equal-time log occurrences by numeric ordinal', () => {
    const logs = Array.from({ length: 12 }, (_, index) => fallbackCompleted(
      `log:${index}:delivery`, 'log', 0, { responseTokens: index },
    ));

    expect(materializeSession(logs).toolCalls.map((call) => call.responseTokens))
      .toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  it('merges production fallback keys across completion phases and keeps Hook failure fields', () => {
    const log = fallbackCompleted('log-after', 'log', 2, {
      phase: 'tool-after', durationMs: 3, isError: false, responseTokens: 42,
    });
    const hook = fallbackCompleted('hook-failure', 'hook', 0, {
      phase: 'tool-failure', durationMs: 25, isError: true,
    });
    expect(log.correlationKey).not.toBe(hook.correlationKey);

    const result = materializeSession([log, hook]);

    expect(result.toolCalls).toMatchObject([{
      durationMs: 25, isError: true, responseTokens: 42, externalCallId: null,
    }]);
  });

  it('uses order-preserving alignment instead of a crossing greedy association', () => {
    const result = materializeSession([
      fallbackCompleted('hook-0', 'hook', 0),
      fallbackCompleted('hook-1', 'hook', 10_000),
      fallbackCompleted('log-0', 'log', 9_000, { responseTokens: 109 }),
      fallbackCompleted('log-1', 'log', 20_000, { responseTokens: 120 }),
    ]);

    expect(result.toolCalls.map((call) => ({
      durationMs: call.durationMs,
      responseTokens: call.responseTokens,
    }))).toEqual([
      { durationMs: 10, responseTokens: 109 },
      { durationMs: 10_010, responseTokens: 120 },
    ]);
  });

  it('does not pair completed observations beyond the correlation grace window', () => {
    const result = materializeSession([
      fallbackCompleted('hook', 'hook', 0),
      fallbackCompleted('log', 'log', CORRELATION_GRACE_MS + 1, { responseTokens: 77 }),
    ]);

    expect(result.toolCalls.map((call) => ({
      durationMs: call.durationMs,
      responseTokens: call.responseTokens,
    }))).toEqual([
      { durationMs: 10, responseTokens: null },
      { durationMs: 7, responseTokens: 77 },
    ]);
  });

  it('pairs exact native identities regardless of elapsed time or timestamp validity', () => {
    const native = observation({
      externalCallId: 'native-call',
      correlationConfidence: 'high',
      observedAt: observedAt(0),
    });
    const correlationKey = makeCorrelationKey(native);
    const result = materializeSession([
      { ...native, deliveryId: 'native-hook', correlationKey, source: 'hook',
        observedAt: 'not-a-hook-time', durationMs: 25, responseTokens: null },
      { ...native, deliveryId: 'log:0:native', correlationKey, source: 'log',
        observedAt: observedAt(CORRELATION_GRACE_MS * 2), durationMs: 3, responseTokens: 42 },
    ]);

    expect(result.toolCalls).toMatchObject([{
      externalCallId: 'native-call', durationMs: 25, responseTokens: 42,
    }]);
  });

  it('orders fallback occurrences by parsed instant across ISO timezone offsets', () => {
    const result = materializeSession([
      fallbackCompleted('hook-earlier', 'hook', 0, {
        observedAt: '2026-01-01T01:00:00+01:00', durationMs: 100,
      }),
      fallbackCompleted('hook-later', 'hook', 0, {
        observedAt: '2026-01-01T00:00:05Z', durationMs: 500,
      }),
      fallbackCompleted('log:0:earlier', 'log', 0, {
        observedAt: '2026-01-01T00:00:01Z', responseTokens: 1,
      }),
      fallbackCompleted('log:1:later', 'log', 0, {
        observedAt: '2026-01-01T00:00:06Z', responseTokens: 6,
      }),
    ]);

    expect(result.toolCalls.map((call) => ({
      durationMs: call.durationMs, responseTokens: call.responseTokens,
    }))).toEqual([
      { durationMs: 100, responseTokens: 1 },
      { durationMs: 500, responseTokens: 6 },
    ]);
  });

  it('does not pair completed observations with invalid timestamps', () => {
    const result = materializeSession([
      fallbackCompleted('hook', 'hook', 0, { observedAt: 'not-a-hook-time' }),
      fallbackCompleted('log', 'log', 0, {
        observedAt: 'not-a-log-time', responseTokens: 77,
      }),
    ]);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((call) => call.responseTokens).sort((a, b) =>
      (a ?? -1) - (b ?? -1))).toEqual([null, 77]);
  });

  it('breaks equal-distance alignment ties by stable ordinal, independent of arrival order', () => {
    const observations = [
      fallbackCompleted('hook', 'hook', 10),
      fallbackCompleted('log:10:later-ordinal', 'log', 0, { responseTokens: 10 }),
      fallbackCompleted('log:2:earlier-ordinal', 'log', 0, { responseTokens: 2 }),
    ];

    const forward = materializeSession(observations);
    const reverse = materializeSession([...observations].reverse());
    expect(forward).toEqual(reverse);
    expect(forward.toolCalls.map((call) => ({
      responseTokens: call.responseTokens,
      durationMs: call.durationMs,
    })).sort((a, b) => (a.responseTokens ?? -1) - (b.responseTokens ?? -1))).toEqual([
      { responseTokens: 2, durationMs: 20 },
      { responseTokens: 10, durationMs: 7 },
    ]);
  });

  it('derives commutative session metadata from the full observation set', () => {
    const result = materializeSession([
      observation({
        deliveryId: 'invalid-time', observedAt: '0000-not-a-date',
        transcriptPath: '/tmp/z-transcript.jsonl',
      }),
      observation({
        deliveryId: 'later', observedAt: observedAt(20),
        transcriptPath: '/tmp/b-transcript.jsonl',
      }),
      observation({
        deliveryId: 'earlier', observedAt: observedAt(10),
        transcriptPath: '/tmp/a-transcript.jsonl',
      }),
    ]);

    expect(result.session.startedAt).toBe(observedAt(10));
    expect(result.session.filePath).toBe('/tmp/a-transcript.jsonl');
  });

  it('replaces a prior log snapshot while preserving hook-owned completion fields', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(observation({ phase: 'tool-failure', durationMs: 25, isError: true }));
    const initial = legacyResult();
    initial.toolCalls.push({
      ...initial.toolCalls[0]!, externalCallId: 'obsolete-call', toolName: 'obsolete_tool',
    });
    store.ingest(initial);

    const smallerSnapshot = legacyResult();
    smallerSnapshot.toolCalls[0] = {
      ...smallerSnapshot.toolCalls[0]!, durationMs: null, isError: false, responseTokens: 99,
    };
    store.ingest(smallerSnapshot);

    const persisted = store.observationsForSession(initial.session.sessionId);
    expect(persisted.filter((item) => item.source === 'hook')).toHaveLength(1);
    expect(persisted.filter((item) => item.source === 'log')).toHaveLength(1);
    expect(persisted.some((item) => item.externalCallId === 'obsolete-call')).toBe(false);
    expect(store.callsSince('2000-01-01')).toMatchObject([{
      toolName: 'get_issue', durationMs: 25, isError: true, responseTokens: 99,
    }]);
  });

  it('does not let a transcript reparse erase hook error or duration', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(observation({ phase: 'tool-failure', durationMs: 25, isError: true }));
    const reparsed = legacyResult();
    reparsed.toolCalls[0] = { ...reparsed.toolCalls[0]!, durationMs: null, isError: false };
    store.ingest(reparsed);

    expect(store.callsSince('2000-01-01')).toMatchObject([{ durationMs: 25, isError: true }]);
  });

  it('joins a hook tool-before to one log-metered load', async () => {
    const store = await LensStore.open(':memory:');
    const correspondingHook = logLoad('hook-before', 0);
    store.upsertObservation({ ...correspondingHook, source: 'hook', loadedTokens: null });
    const result = legacyResult();
    result.toolCalls = [];
    result.toolLoads = [{
      sessionId: result.session.sessionId,
      serverName: 'github',
      toolName: 'get_issue',
      loadedTokens: 31,
    }];

    store.ingest(result);

    expect(store.loadsSince('2000-01-01')).toMatchObject([{
      serverName: 'github', toolName: 'get_issue', loadedTokens: 31,
    }]);
  });

  it('preserves repeated log-only load cardinality when fallback identities collide', async () => {
    const store = await LensStore.open(':memory:');
    const result = legacyResult();
    result.toolCalls = [];
    result.toolLoads = [
      { sessionId: result.session.sessionId, serverName: 'github', toolName: 'get_issue', loadedTokens: 11 },
      { sessionId: result.session.sessionId, serverName: 'github', toolName: 'get_issue', loadedTokens: 22 },
    ];

    store.ingest(result);

    expect(store.loadsSince('2000-01-01').map((load) => load.loadedTokens)).toEqual([11, 22]);
  });

  it('uniquely attributes an exact Codex exposed load to a configured scanned definition', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('atlas', 'lookup')]);
    store.upsertClientServers(new Map([['atlas', new Set<ClientId>(['codex'])]]), new Set(['codex']));

    store.ingest(exactCodexLoad('mcp__atlas__lookup'));
    expect(store.loadsSince('2000-01-01')).toEqual([{
      sessionId: 'codex-exact-load-session', serverName: 'atlas', toolName: 'lookup', loadedTokens: 37,
    }]);

    store.ingest(exactCodexLoad('mcp__atlas__lookup'));
    expect(store.loadsSince('2000-01-01')).toHaveLength(1);
  });

  it('does not attribute ambiguous or unconfigured Codex exposed loads', async () => {
    const ambiguous = await LensStore.open(':memory:');
    ambiguous.upsertDefinitions([definition('atlas', 'deep__lookup'), definition('atlas__deep', 'lookup')]);
    ambiguous.upsertClientServers(new Map([
      ['atlas', new Set<ClientId>(['codex'])], ['atlas__deep', new Set<ClientId>(['codex'])],
    ]), new Set(['codex']));
    ambiguous.ingest(exactCodexLoad('mcp__atlas__deep__lookup'));
    expect(ambiguous.loadsSince('2000-01-01')[0]).toMatchObject({
      serverName: null, toolName: 'mcp__atlas__deep__lookup',
    });
    expect(visibleActionCandidates(ambiguous)).not.toContainEqual(expect.objectContaining({
      serverName: 'atlas', toolName: 'deep__lookup',
    }));
    expect(visibleActionCandidates(ambiguous)).not.toContainEqual(expect.objectContaining({
      serverName: 'atlas__deep', toolName: 'lookup',
    }));

    const unconfigured = await LensStore.open(':memory:');
    unconfigured.upsertDefinitions([definition('atlas', 'lookup')]);
    unconfigured.upsertClientServers(new Map([
      ['other', new Set<ClientId>(['codex'])],
    ]), new Set(['codex']));
    unconfigured.ingest(exactCodexLoad('mcp__atlas__lookup'));
    expect(unconfigured.loadsSince('2000-01-01')[0]).toMatchObject({
      serverName: null, toolName: 'mcp__atlas__lookup',
    });
    expect(visibleActionCandidates(unconfigured)).not.toContainEqual(expect.objectContaining({
      serverName: 'atlas', toolName: 'lookup',
    }));
  });

  it('records one direct regret signal when a Claude log fallback and hook share a session', async () => {
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction({
      actionId: 'claude-log-action', client: 'claude-code', serverName: 'github', toolName: 'get_issue',
      ownedRule: 'mcp__github__get_issue',
    }));
    const hook = observation({
      client: 'claude-code', externalSessionId: 'claude-log-session', serverName: 'github',
      toolName: 'get_issue', phase: 'tool-before', observedAt: NOW,
    });
    store.upsertObservation(hook);
    store.ingest({
      session: { sessionId: 'claude-log-session-id', client: 'claude-code', filePath: '/tmp/claude-log.jsonl',
        externalSessionId: 'claude-log-session', startedAt: NOW, mode: 'UPFRONT' },
      toolCalls: [{ sessionId: 'claude-log-session-id', serverName: 'github', toolName: 'get_issue',
        calledAt: NOW, durationMs: null, isError: true, responseTokens: null, responseText: null }],
      toolLoads: [], usage: [], parseErrors: 0,
    });

    expect(store.regretSignals('claude-log-action')).toHaveLength(1);
  });

  it.each([true, false])('records direct regret from a structured Claude log %s without a hook', async (isError) => {
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction({
      actionId: 'claude-log-only-action', client: 'claude-code', serverName: 'github', toolName: 'get_issue',
      ownedRule: 'mcp__github__get_issue',
    }));
    store.ingest({
      session: { sessionId: 'claude-log-only-session-id', client: 'claude-code', filePath: '/tmp/claude-log-only.jsonl',
        externalSessionId: 'claude-log-only-session', startedAt: NOW, mode: 'UPFRONT' },
      toolCalls: [{ sessionId: 'claude-log-only-session-id', serverName: 'github', toolName: 'get_issue',
        calledAt: NOW, durationMs: null, isError, responseTokens: null, responseText: null }],
      toolLoads: [], usage: [], parseErrors: 0,
    });

    expect(store.regretSignals('claude-log-only-action')).toEqual([{
      actionId: 'claude-log-only-action', kind: 'direct', sessionId: 'claude-log-only-session', observedAt: NOW,
    }]);
  });

  it('does not record direct regret from a generic Claude log tool-before', async () => {
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction({
      actionId: 'claude-log-before-action', client: 'claude-code', serverName: 'github', toolName: 'get_issue',
      ownedRule: 'mcp__github__get_issue',
    }));
    store.ingest({
      session: { sessionId: 'claude-log-before-session-id', client: 'claude-code', filePath: '/tmp/claude-log-before.jsonl',
        externalSessionId: 'claude-log-before-session', startedAt: NOW, mode: 'DEFERRED_OPAQUE' },
      toolCalls: [],
      toolLoads: [{ sessionId: 'claude-log-before-session-id', serverName: 'github', toolName: 'get_issue', loadedTokens: null }],
      usage: [], parseErrors: 0,
    });

    expect(store.regretSignals('claude-log-before-action')).toEqual([]);
  });

  it('does not record indirect regret from a canonical broad Codex no-match', async () => {
    const adapter = new CodexAdapter();
    const result = adapter.parseFile('/tmp/codex-broad-no-match.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-no-match', input: 'ALL_TOOLS.filter(x => x.name.includes("mcp__atlas__lookup"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-no-match', output: 'TOOL_NOT_FOUND' } }),
    ].join('\n'));
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction());
    store.ingest(result);

    expect(result.toolSearchAttempts ?? []).toEqual([]);
    expect(store.regretSignals('codex-exact-action')).toEqual([]);
  });

  it('does not record indirect regret from malformed canonical no-match framing', async () => {
    const adapter = new CodexAdapter();
    const result = adapter.parseFile('/tmp/codex-malformed-no-match.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'malformed-no-match', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'malformed-no-match', output: [
        { type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: '{bad-json' },
      ] } }),
    ].join('\n'));
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction());
    store.ingest(result);

    expect(result.toolSearchAttempts ?? []).toEqual([]);
    expect(store.regretSignals('codex-exact-action')).toEqual([]);
  });

  it('does not record indirect regret from an empty Codex content-block array', async () => {
    const adapter = new CodexAdapter();
    const result = adapter.parseFile('/tmp/codex-empty-content.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'empty-content', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'empty-content', output: [] } }),
    ].join('\n'));
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction());
    store.ingest(result);

    expect(result.toolSearchAttempts ?? []).toEqual([]);
    expect(store.regretSignals('codex-exact-action')).toEqual([]);
  });

  it('does not record indirect regret from duplicate Codex no-match evidence', async () => {
    const adapter = new CodexAdapter();
    const result = adapter.parseFile('/tmp/codex-duplicate-no-match.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'duplicate-no-match', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'duplicate-no-match', output: [
        { type: 'input_text', text: '[]' }, { type: 'input_text', text: '[]' },
      ] } }),
    ].join('\n'));
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(codexAction());
    store.ingest(result);

    expect(result.toolSearchAttempts ?? []).toEqual([]);
    expect(store.regretSignals('codex-exact-action')).toEqual([]);
  });

  it('does not materialize a hook tool-before without log load evidence', () => {
    expect(materializeSession([observation({
      phase: 'tool-before', externalCallId: null, durationMs: null, isError: null,
    })]).toolLoads).toEqual([]);
  });

  it('only materializes completed calls and keeps log metering over hook data', () => {
    const result = materializeSession([
      observation({ phase: 'tool-before', deliveryId: 'before', loadedTokens: null }),
      observation({ deliveryId: 'hook-complete' }),
      observation({ source: 'log', deliveryId: 'log', responseTokens: 42, durationMs: 1 }),
      logLoad('log-load', 10),
    ]);

    expect(result.toolCalls).toMatchObject([{ responseTokens: 42, durationMs: 25 }]);
    expect(result.toolLoads).toMatchObject([{ loadedTokens: 10 }]);
    expect(materializeSession([observation({ phase: 'tool-before' })]).toolCalls).toEqual([]);
  });
});

describe('LensStore observation APIs', () => {
  it('integrates the H5 coordinator transaction with the concrete store', async () => {
    const root = temporaryRoot();
    const store = await LensStore.open(':memory:');
    enqueueEnvelope(hookEnvelope(), { root });
    const coordinator = new IngestionCoordinator({ inbox: { root }, store });

    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 1, parseErrors: 0 });
    expect(store.observationCount()).toBe(1);
    expect(store.callsSince('2000-01-01')).toHaveLength(1);
  });

  it('durably commits a coordinator drain before marking the inbox item processed', async () => {
    const root = temporaryRoot();
    const path = join(root, 'lens.db');
    const store = await LensStore.open(path);
    enqueueEnvelope(hookEnvelope(), { root: join(root, 'inbox') });
    const coordinator = new IngestionCoordinator({
      inbox: { root: join(root, 'inbox') },
      store,
    });

    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 1, parseErrors: 0 });
    store.close();

    expect(existsSync(path)).toBe(true);
    const reopened = await LensStore.open(path);
    expect(reopened.observationCount()).toBe(1);
    expect(reopened.callsSince('2000-01-01')).toHaveLength(1);
    reopened.close();
  });

  it('throws on checkpoint failure, releases the claim, and can retry it', async () => {
    const root = temporaryRoot();
    const blocker = join(root, 'not-a-directory');
    const path = join(blocker, 'lens.db');
    const inboxRoot = join(root, 'inbox');
    writeFileSync(blocker, 'block checkpoint creation');
    const store = await LensStore.open(path);
    enqueueEnvelope(hookEnvelope(), { root: inboxRoot });
    const coordinator = new IngestionCoordinator({ inbox: { root: inboxRoot }, store });

    await expect(coordinator.drainInbox()).rejects.toThrow();
    expect(existsSync(join(inboxRoot, 'pending', 'delivery-hook.json'))).toBe(true);

    rmSync(blocker);
    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 1, parseErrors: 0 });
    store.close();

    const reopened = await LensStore.open(path);
    expect(reopened.observationCount()).toBe(1);
    reopened.close();
  });

  it('changes transaction depth only after successful SQL transitions', async () => {
    const store = await LensStore.open(':memory:');
    const internals = store as unknown as {
      db: { exec(sql: string): void };
      transactionDepth: number;
    };
    const exec = internals.db.exec.bind(internals.db);

    internals.db.exec = (sql) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      exec(sql);
    };
    expect(() => store.begin()).toThrow('begin failed');
    expect(internals.transactionDepth).toBe(0);

    internals.db.exec = exec;
    store.begin();
    internals.db.exec = (sql) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      exec(sql);
    };
    expect(() => store.commit()).toThrow('commit failed');
    expect(internals.transactionDepth).toBe(1);

    internals.db.exec = (sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      exec(sql);
    };
    expect(() => store.rollback()).toThrow('rollback failed');
    expect(internals.transactionDepth).toBe(1);

    internals.db.exec = exec;
    store.rollback();
    store.close();
  });

  it('promotes a fallback session alias to a native ID without stale logs or lost Hooks', async () => {
    const root = temporaryRoot();
    const path = join(root, 'promotion.db');
    const store = await LensStore.open(path);
    const fallbackId = 'transcript-session-id';
    const nativeId = 'native-session-id';
    store.ingest(resultForSession(fallbackId, null, 'get_issue', 11));
    const fallbackHook = observation({
      deliveryId: 'fallback-hook',
      externalSessionId: fallbackId,
      externalCallId: 'call-1',
      durationMs: 25,
    });
    fallbackHook.correlationKey = makeCorrelationKey(fallbackHook);
    store.upsertObservation(fallbackHook);
    store.ingest(resultForSession(fallbackId, nativeId, 'get_issue', 22));

    expect(store.observationCount()).toBe(2);
    expect(store.observationsForSession(fallbackId).map((item) => ({
      source: item.source,
      externalSessionId: item.externalSessionId,
    }))).toEqual([
      { source: 'hook', externalSessionId: nativeId },
      { source: 'log', externalSessionId: nativeId },
    ]);
    expect(store.callsSince('2000-01-01')).toMatchObject([{
      sessionId: fallbackId,
      durationMs: 25,
      responseTokens: 22,
    }]);
    store.close();

    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(path));
    const aliases = db.exec(
      `SELECT external_session_id FROM session_aliases
       WHERE client='codex' AND session_id='transcript-session-id'
       ORDER BY external_session_id`,
    )[0]?.values.flat() ?? [];
    db.close();
    expect(aliases).toEqual([nativeId]);
  });

  it('keeps a canonical session when another alias still references it during reassignment', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(resultForSession('canonical-a', 'alias-a', 'tool_a', 10));
    store.ingest(resultForSession('canonical-a', 'alias-b', 'tool_b_old', 20));
    store.ingest(resultForSession('canonical-b', 'alias-b', 'tool_b_new', 30));

    expect(store.sessionsSince('2000-01-01').map((session) => session.sessionId).sort())
      .toEqual(['canonical-a', 'canonical-b']);
    expect(store.observationsForSession('canonical-a').map((item) => item.toolName))
      .toEqual(['tool_a']);
    expect(store.callsSince('2000-01-01').map((call) => ({
      sessionId: call.sessionId,
      toolName: call.toolName,
    })).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 'canonical-a', toolName: 'tool_a' },
      { sessionId: 'canonical-b', toolName: 'tool_b_new' },
    ]);
  });

  it.each([
    ['completion before session-start', ['completion', 'session-start']],
    ['session-start before completion', ['session-start', 'completion']],
  ] as const)('recomputes metadata for %s', async (_name, order) => {
    const store = await LensStore.open(':memory:');
    const completion = resultForSession('metadata-session', 'metadata-native', 'get_issue', 42);
    completion.session = {
      ...completion.session,
      filePath: '/tmp/z-transcript.jsonl',
      startedAt: observedAt(20),
      mode: 'DEFERRED_MEASURABLE',
    };
    completion.toolCalls[0] = {
      ...completion.toolCalls[0]!,
      calledAt: observedAt(20),
    };
    const sessionStart = observation({
      deliveryId: 'session-start',
      phase: 'session-start',
      externalSessionId: 'metadata-native',
      externalCallId: null,
      transcriptPath: '/tmp/a-transcript.jsonl',
      serverName: null,
      toolName: null,
      observedAt: observedAt(10),
      durationMs: null,
      isError: null,
    });
    sessionStart.correlationKey = makeCorrelationKey(sessionStart);

    for (const item of order) {
      if (item === 'completion') store.ingest(completion);
      else store.upsertObservation(sessionStart);
    }

    expect(store.sessionsSince('2000-01-01')).toMatchObject([{
      sessionId: 'metadata-session',
      startedAt: observedAt(10),
      filePath: '/tmp/a-transcript.jsonl',
      mode: 'DEFERRED_MEASURABLE',
    }]);
  });

  it('returns all privacy-safe sources for a canonical session', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertObservation(observation());
    store.ingest(legacyResult());

    const observations = store.observationsForSession('legacy-session-1');
    expect(observations.map((item) => item.source)).toEqual(['hook', 'log']);
    expect(observations.map((item) => item.deliveryId)).toEqual([
      'delivery-hook',
      expect.stringMatching(/^log:/),
    ]);
  });

  it('records collector receipts idempotently', async () => {
    const root = temporaryRoot();
    const path = join(root, 'receipts.db');
    const store = await LensStore.open(path);
    const receipt = {
      receiptId: 'receipt-1', client: 'codex' as const, kind: 'drain', status: 'ok',
      observedAt: NOW, errorCode: null,
    };
    store.recordReceipt(receipt);
    store.recordReceipt(receipt);
    store.save();
    store.close();

    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(path));
    const statement = db.prepare('SELECT * FROM collector_receipts');
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    statement.free();
    db.close();
    expect(rows).toMatchObject([{
      receipt_id: 'receipt-1', client: 'codex', kind: 'drain', status: 'ok',
      observed_at: NOW, error_code: null,
    }]);
  });

  it('derives collection health from persisted hook and log evidence', async () => {
    const store = await LensStore.open(':memory:');
    expect(store.collectionHealth(NOW).health).toBe('idle');
    store.upsertObservation(observation());
    expect(store.collectionHealth(NOW).health).toBe('hook-only');
    store.ingest(legacyResult());

    expect(store.collectionHealth(NOW)).toMatchObject({
      health: 'healthy', hookObserved: true, logObserved: true,
      consecutiveMatches: 1, waitingForCorrelation: 0,
    });
  });

  it('preserves the exact three-client fixture call and load counts in log-only mode', async () => {
    const fixtures: readonly [ClientId, AdapterResult][] = [
      ['claude-code', new ClaudeAdapter().parseFile(
        '/fx/claude.jsonl', readFileSync(resolve('fixtures/claude/session-toolsearch.jsonl'), 'utf8'),
      )],
      ['codex', new CodexAdapter().parseFile(
        '/fx/codex.jsonl', readFileSync(resolve('fixtures/codex/rollout-codemode.jsonl'), 'utf8'),
      )],
      ['gemini-cli', new GeminiAdapter().parseFile(
        '/fx/gemini.jsonl', readFileSync(resolve('fixtures/gemini/chat-upfront.jsonl'), 'utf8'),
      )],
    ];
    const store = await LensStore.open(':memory:');
    for (const [, result] of fixtures) store.ingest(result);

    expect(store.callsSince('1970-01-01')).toHaveLength(
      fixtures.reduce((count, [, result]) => count + result.toolCalls.length, 0),
    );
    expect(store.loadsSince('1970-01-01')).toHaveLength(
      fixtures.reduce((count, [, result]) => count + result.toolLoads.length, 0),
    );
    expect(new Set(store.sessionsSince('1970-01-01').map((session) => session.client))).toEqual(
      new Set(fixtures.map(([client]) => client)),
    );
  });

  it('does not persist raw tool input, response, or prompt bodies', async () => {
    const root = temporaryRoot();
    const path = join(root, 'privacy.db');
    const store = await LensStore.open(path);
    const result = legacyResult();
    result.toolCalls[0] = {
      ...result.toolCalls[0]!,
      responseText: 'PRIVATE_RESPONSE_BODY',
      toolInput: 'PRIVATE_TOOL_INPUT',
      promptBody: 'PRIVATE_PROMPT_BODY',
    } as typeof result.toolCalls[number];
    store.ingest(result);
    store.upsertObservation({
      ...observation({ deliveryId: 'privacy-hook' }),
      toolInput: 'PRIVATE_HOOK_INPUT',
      promptBody: 'PRIVATE_HOOK_PROMPT',
    } as ToolObservation);
    store.save();
    store.close();

    const persisted = readFileSync(path).toString('latin1');
    expect(persisted).not.toContain('PRIVATE_RESPONSE_BODY');
    expect(persisted).not.toContain('PRIVATE_TOOL_INPUT');
    expect(persisted).not.toContain('PRIVATE_PROMPT_BODY');
    expect(persisted).not.toContain('PRIVATE_HOOK_INPUT');
    expect(persisted).not.toContain('PRIVATE_HOOK_PROMPT');
  });

  it('binds the first native Hook to a legacy session with the same transcript path', async () => {
    const root = temporaryRoot();
    const path = join(root, 'legacy-first-hook.db');
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, client TEXT NOT NULL,
      file_path TEXT NOT NULL, started_at TEXT, mode TEXT NOT NULL);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL, called_at TEXT, duration_ms INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0, response_tokens INTEGER);
      INSERT INTO sessions VALUES(
        'legacy-canonical','codex','/tmp/legacy-first-hook.jsonl','${NOW}','DEFERRED_MEASURABLE');
      INSERT INTO tool_calls(session_id,server_name,tool_name,called_at,duration_ms,is_error,response_tokens)
        VALUES('legacy-canonical','github','get_issue','${NOW}',3,0,11);`);
    writeFileSync(path, Buffer.from(legacy.export()));
    legacy.close();

    const store = await LensStore.open(path);
    store.upsertObservation(fallbackCompleted('first-native-hook', 'hook', 0, {
      phase: 'tool-failure',
      externalSessionId: 'native-session-id',
      transcriptPath: '/tmp/legacy-first-hook.jsonl',
      durationMs: 25,
      isError: true,
    }));

    expect(store.sessionsSince('2000-01-01')).toMatchObject([{
      sessionId: 'legacy-canonical',
      externalSessionId: 'native-session-id',
      filePath: '/tmp/legacy-first-hook.jsonl',
    }]);
    expect(store.observationsForSession('legacy-canonical').map((item) => item.source).sort())
      .toEqual(['hook', 'log']);
    expect(store.callsSince('2000-01-01')).toMatchObject([{
      sessionId: 'legacy-canonical', toolName: 'get_issue', durationMs: 25,
      isError: true, responseTokens: 11,
    }]);
    store.close();

    const persisted = new SQL.Database(readFileSync(path));
    const aliases = persisted.exec(
      `SELECT session_id FROM session_aliases
       WHERE client='codex' AND external_session_id='native-session-id'`,
    )[0]?.values.flat() ?? [];
    persisted.close();
    expect(aliases).toEqual(['legacy-canonical']);
  });

  it('opens a legacy database without losing existing data', async () => {
    const root = temporaryRoot();
    const path = join(root, 'legacy.db');
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, client TEXT NOT NULL,
      file_path TEXT NOT NULL, started_at TEXT, mode TEXT NOT NULL);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL, called_at TEXT, duration_ms INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0, response_tokens INTEGER);
      CREATE TABLE tool_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      server_name TEXT, tool_name TEXT NOT NULL, loaded_tokens INTEGER);
      CREATE TABLE tool_definitions (server_name TEXT NOT NULL, tool_name TEXT NOT NULL,
      definition_tokens INTEGER NOT NULL, scanned_at TEXT NOT NULL,
      PRIMARY KEY(server_name, tool_name));
      CREATE TABLE file_cursors (file_path TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL);
      INSERT INTO sessions VALUES('legacy','codex','/tmp/legacy.jsonl','${NOW}','DEFERRED_MEASURABLE');
      INSERT INTO tool_calls(session_id,server_name,tool_name,called_at,duration_ms,is_error,response_tokens)
        VALUES('legacy','github','old_call','${NOW}',3,0,11);
      INSERT INTO tool_loads(session_id,server_name,tool_name,loaded_tokens)
        VALUES('legacy','github','old_load',17);
      INSERT INTO tool_definitions VALUES('github','old_definition',700,'${NOW}');
      INSERT INTO file_cursors VALUES('/tmp/legacy.jsonl',123,456);`);
    writeFileSync(path, Buffer.from(legacy.export()));
    legacy.close();

    const store = await LensStore.open(path);
    expect(store.sessionsSince('2000-01-01')).toMatchObject([{
      sessionId: 'legacy', filePath: '/tmp/legacy.jsonl',
    }]);
    expect(store.callsSince('2000-01-01')).toMatchObject([{
      sessionId: 'legacy', toolName: 'old_call', responseTokens: 11,
    }]);
    expect(store.loadsSince('2000-01-01')).toMatchObject([{
      sessionId: 'legacy', toolName: 'old_load', loadedTokens: 17,
    }]);
    expect(store.allDefinitions()).toMatchObject([{
      serverName: 'github', toolName: 'old_definition', definitionTokens: 700,
      firstScannedAt: NOW,
    }]);
    expect(store.getCursor('/tmp/legacy.jsonl')).toEqual({ byteOffset: 123, mtimeMs: 456 });
    expect(store.observationCount()).toBe(0);
    store.close();
  });
});

describe('public core observation API', () => {
  it('exports the coordinator and collection-health runtime surfaces required by H9', async () => {
    const core = await import('../../src/index.js');

    expect(core.IngestionCoordinator).toBe(IngestionCoordinator);
    expect(core.deriveCollectionHealth).toBeTypeOf('function');
    expect(core.CORRELATION_GRACE_MS).toBeTypeOf('number');
    expect(core.MISSES_TO_DEGRADE).toBeTypeOf('number');
    expect(core.MATCHES_TO_RECOVER).toBeTypeOf('number');
  });

  it('keeps the H9 coordinator and health type surfaces assignable', () => {
    const input: CollectionHealthInput = { now: NOW, observations: [] };
    const snapshot: CollectionHealthSnapshot = {
      health: 'idle', hookObserved: false, logObserved: false,
      consecutiveMisses: 0, consecutiveMatches: 0, waitingForCorrelation: 0,
      lastEventAt: null,
    };
    const store = { upsertObservation: () => undefined };
    const options: IngestionCoordinatorOptions = { store };
    const result: IngestionResult = { ingested: 0, parseErrors: 0 };

    expect({ input, snapshot, options, result }).toBeDefined();
  });
});
