import { afterEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LensStore } from '../../src/store/store.js';
import type {
  DependencyAnalysis,
  GlobalAction,
  InferenceConsent,
  ServerIdentity,
  ToolDefinition,
  ToolDefinitionBody,
} from '../../src/types.js';
import type { ToolObservation } from '../../src/ingest/contracts.js';

const NOW = '2026-08-03T00:00:00.000Z';
const temporaryRoots: string[] = [];

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcplens-v2-contracts-'));
  temporaryRoots.push(root);
  return join(root, 'lens.db');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const definition: ToolDefinition = {
  serverName: 'github', toolName: 'get_issue', definitionTokens: 120,
  scannedAt: NOW, firstScannedAt: NOW,
};

const body: ToolDefinitionBody = {
  serverName: 'github', toolName: 'get_issue', description: 'Get an issue',
  inputSchemaJson: '{"type":"object"}', outputSchemaJson: null, definitionTokens: 120,
  definitionSetHash: 'definitions-v1', scannedAt: NOW,
};

const identity: ServerIdentity = {
  client: 'claude-code', serverName: 'github', sourceKind: 'claude-user',
  sourcePathHash: 'source-hash', transport: 'stdio', endpointHash: 'endpoint-hash',
  conflictState: 'clear', observedAt: NOW,
};

function analysis(overrides: Partial<DependencyAnalysis> = {}): DependencyAnalysis {
  return {
    definitionSetHash: 'definitions-v1', analysisRulesVersion: 1,
    provider: 'claude', model: 'haiku', status: 'complete', analyzedAt: NOW,
    errorCode: null,
    observedSessionCount: 0,
    results: [{
      serverName: 'github', toolName: 'get_issue', status: 'Independent',
      dependedOnBy: [], rationale: 'No observed or semantic dependency.',
      displaySummary: 'Reads one issue.', whatYouLose: 'Issue lookup.',
      riskWithoutTool: 'Manual lookup is required.',
    }],
    ...overrides,
  };
}

function action(overrides: Partial<GlobalAction> = {}): GlobalAction {
  return {
    actionId: 'action-1', client: 'codex', serverName: 'github', toolName: 'get_issue',
    identityHash: 'identity-hash', definitionSetHash: 'definitions-v1',
    ownedRule: 'github_get_issue', backupPath: '/tmp/backup',
    preFingerprint: 'before', postFingerprint: 'after', status: 'active',
    createdAt: NOW, restoredAt: null,
    ...overrides,
  };
}

describe('LensStore v2 contracts', () => {
  it('creates the v2 DDL idempotently when a database is opened twice', async () => {
    const path = temporaryDatabase();
    const first = await LensStore.open(path);
    first.upsertScanResult([definition], [body], [identity]);
    first.close();

    const second = await LensStore.open(path);
    expect(second.definitionBodiesForServer('github')).toEqual([body]);
    expect(second.serverIdentities('github')).toEqual([identity]);
    second.close();

    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(path));
    const schema = db.exec(
      `SELECT type, name FROM sqlite_master
       WHERE name IN ('server_identities', 'tool_definition_bodies',
         'dependency_analyses', 'tool_dependency_results', 'tool_explanations',
         'global_actions', 'regret_signals', 'inference_consents',
         'idx_server_identity_name', 'idx_definition_set_hash',
         'idx_one_active_global_action')
       ORDER BY name`,
    )[0]?.values ?? [];
    db.close();
    expect(schema).toHaveLength(11);
  });

  it('replaces an analysis and its optional explanations in one transaction', async () => {
    const store = await LensStore.open(':memory:');
    store.saveDependencyAnalysis(analysis());
    expect(store.findDependencyAnalysis('definitions-v1', 1)).toEqual(analysis());

    const replacement = analysis({
      provider: 'codex', model: 'gpt-5.6-luna', analyzedAt: '2026-08-04T00:00:00.000Z',
      results: [{
        serverName: 'github', toolName: 'search_issues', status: 'Review required',
        dependedOnBy: ['github/get_issue'], rationale: 'Often precedes issue reads.',
        displaySummary: null, whatYouLose: null, riskWithoutTool: null,
      }],
    });
    store.saveDependencyAnalysis(replacement);

    expect(store.findDependencyAnalysis('definitions-v1', 1)).toEqual(replacement);
  });

  it('rolls back the complete analysis replacement when a result is invalid', async () => {
    const store = await LensStore.open(':memory:');
    const original = analysis();
    store.saveDependencyAnalysis(original);
    const invalid = analysis({
      model: 'replacement',
      results: [{ ...original.results[0]!, dependedOnBy: undefined as unknown as string[] }],
    });

    expect(() => store.saveDependencyAnalysis(invalid)).toThrow();
    expect(store.findDependencyAnalysis('definitions-v1', 1)).toEqual(original);
  });

  it('enforces only one active global action per client and tool', async () => {
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(action());
    expect(() => store.recordGlobalAction(action({ actionId: 'action-2' }))).toThrow();

    store.updateGlobalActionStatus('action-1', 'restored', '2026-08-05T00:00:00.000Z');
    store.recordGlobalAction(action({ actionId: 'action-2' }));
    expect(store.activeActions().map((item) => item.actionId)).toEqual(['action-2']);
    expect(store.activeActionFor('codex', 'github', 'get_issue')?.actionId).toBe('action-2');
  });

  it('records regret signals idempotently by action, kind, and session', async () => {
    const store = await LensStore.open(':memory:');
    const signal = {
      actionId: 'action-1', kind: 'indirect' as const,
      sessionId: 'session-1', observedAt: NOW,
    };
    store.recordRegretSignal(signal);
    store.recordRegretSignal({ ...signal, observedAt: '2026-08-04T00:00:00.000Z' });

    expect(store.regretSignals('action-1')).toEqual([signal]);
  });

  it('records regret only when observations and Codex searches exactly match active actions', async () => {
    const store = await LensStore.open(':memory:');
    store.recordGlobalAction(action({
      actionId: 'claude-action', client: 'claude-code', ownedRule: 'mcp__github__get_issue',
    }));
    store.recordGlobalAction(action({ actionId: 'codex-action' }));
    const observation: ToolObservation = {
      schemaVersion: 1, deliveryId: 'delivery-1', client: 'claude-code', source: 'hook',
      phase: 'tool-before', receivedAt: '2026-08-03T00:00:01.000Z',
      externalSessionId: 'claude-session', externalTurnId: null, externalCallId: 'call-1',
      transcriptPath: null, serverName: 'github', toolName: 'get_issue',
      observedAt: '2026-08-03T00:00:01.000Z', durationMs: null, isError: null,
      inputFingerprint: null, correlationKey: 'key', correlationConfidence: 'high',
      responseTokens: null, loadedTokens: null,
    };

    store.upsertObservation(observation);
    store.ingest({
      session: { sessionId: 'codex-session', client: 'codex', filePath: null, startedAt: NOW, mode: 'DEFERRED_OPAQUE' },
      toolCalls: [], toolLoads: [], usage: [], parseErrors: 0,
      toolSearchAttempts: [
        { sessionId: 'codex-no-match-1', exactToolName: 'mcp__github__get_issue', observedAt: '2026-08-03T00:00:01.000Z', noMatch: true },
        { sessionId: 'codex-legacy', exactToolName: 'github_get_issue', observedAt: '2026-08-03T00:00:02.000Z', noMatch: true },
        { sessionId: 'codex-substring', exactToolName: 'mcp__github__get_issue_extra', observedAt: '2026-08-03T00:00:03.000Z', noMatch: true },
      ],
    });
    store.ingest({
      session: { sessionId: 'codex-session-2', client: 'codex', filePath: null, startedAt: NOW, mode: 'DEFERRED_OPAQUE' },
      toolCalls: [], toolLoads: [], usage: [], parseErrors: 0,
      toolSearchAttempts: [
        { sessionId: 'codex-no-match-2', exactToolName: 'mcp__github__get_issue', observedAt: '2026-08-03T00:00:04.000Z', noMatch: true },
      ],
    });

    expect(store.regretSignals('claude-action')).toEqual([{
      actionId: 'claude-action', kind: 'direct', sessionId: 'claude-session',
      observedAt: '2026-08-03T00:00:01.000Z',
    }]);
    expect(store.regretSignals('codex-action')).toEqual([{
      actionId: 'codex-action', kind: 'indirect', sessionId: 'codex-no-match-1',
      observedAt: '2026-08-03T00:00:01.000Z',
    }, {
      actionId: 'codex-action', kind: 'indirect', sessionId: 'codex-no-match-2',
      observedAt: '2026-08-03T00:00:04.000Z',
    }]);
  });

  it('upserts and returns the current inference consent including revocation', async () => {
    const store = await LensStore.open(':memory:');
    const accepted: InferenceConsent = {
      policyVersion: 1, provider: 'claude', model: 'haiku', status: 'accepted',
      acceptedAt: NOW, revokedAt: null,
    };
    const revoked: InferenceConsent = {
      ...accepted, status: 'revoked', revokedAt: '2026-08-05T00:00:00.000Z',
    };
    store.saveInferenceConsent(accepted);
    store.saveInferenceConsent(revoked);

    expect(store.currentInferenceConsent(1)).toEqual(revoked);
    expect(store.currentInferenceConsent(2)).toBeNull();
  });
});
