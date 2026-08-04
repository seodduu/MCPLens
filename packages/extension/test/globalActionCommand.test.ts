import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { disableGlobally, restoreGlobally } from '../src/globalActionCommand.js';

const action = {
  actionId: 'action-1', client: 'claude-code' as const, serverName: 'docs', toolName: 'search',
  identityHash: 'identity', definitionSetHash: 'a'.repeat(64), ownedRule: 'mcp__docs__search',
  backupPath: '/tmp/settings.json.mcplens-2026-08-03T00-00-00-000Z.bak', preFingerprint: 'before', postFingerprint: 'after',
  status: 'active' as const, createdAt: '2026-08-03T00:00:00.000Z', restoredAt: null,
};

function eligibleStore(overrides: Record<string, unknown> = {}) {
  const definition = { serverName: 'docs', toolName: 'search', definitionTokens: 100,
    scannedAt: '2026-08-10T00:00:00.000Z', firstScannedAt: '2026-08-01T00:00:00.000Z' };
  const body = { ...definition, description: null, inputSchemaJson: '{}', definitionSetHash: action.definitionSetHash };
  const sessions = Array.from({ length: 10 }, (_, index) => ({
    sessionId: `s${index}`, client: 'claude-code' as const, filePath: null,
    startedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, mode: 'UPFRONT' as const,
  }));
  return {
    definitionBodiesForServer: () => [body], allDefinitions: () => [definition],
    callsSince: () => [], loadsSince: () => [], sessionsSince: () => sessions,
    lastCallByTool: () => new Map(), serversByClient: () => new Map([['claude-code', new Set(['docs'])]]),
    serverIdentities: () => [{ client: 'claude-code', conflictState: 'clear', endpointHash: 'identity' }],
    collectionHealthByClient: () => new Map([['claude-code', { health: 'healthy' }]]),
    findDependencyAnalysis: () => ({ results: [{ serverName: 'docs', toolName: 'search', status: 'Independent' }]}),
    activeActionFor: () => null, hasRestoredActionSince: () => false,
    recordGlobalAction: vi.fn(), save: vi.fn(), ...overrides,
  };
}

describe('global action commands', () => {
  it('routes legacy tool commands through v2 guards and fails closed for server-wide commands', () => {
    const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
    expect(source).toContain("registerCommand('mcp-lens.removeTool', legacyRemoveTool)");
    expect(source).toContain("registerCommand('mcp-lens.addTool', legacyAddTool)");
    expect(source).toContain("await disable(node);");
    expect(source).toContain("await restore(node);");
    expect(source).toContain("registerCommand('mcp-lens.removeServer', rejectLegacyServerAction)");
    expect(source).toContain("registerCommand('mcp-lens.addServer', rejectLegacyServerAction)");
    expect(source).not.toContain('denyMcpTool(');
    expect(source).not.toContain('disableServer(');
  });

  it('rejects a stale definition before mutating a configuration file', async () => {
    const apply = vi.fn();
    const refresh = vi.fn();
    const result = await disableGlobally({
      store: { definitionBodiesForServer: () => [{ definitionSetHash: 'new' }], serverIdentities: () => [] } as any,
      target: { client: 'claude-code', serverName: 'docs', toolName: 'search', definitionSetHash: 'old' },
      apply, refresh, rolloutAllowed: true,
    });
    expect(result).toEqual({ ok: false, message: 'Analysis is stale. Refreshing the tree.' });
    expect(apply).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('records an action only after the adapter applies it', async () => {
    const store = eligibleStore();
    const result = await disableGlobally({
      store: store as any,
      target: { client: 'claude-code', serverName: 'docs', toolName: 'search', definitionSetHash: action.definitionSetHash },
      rolloutAllowed: true, analysisRulesVersion: 1,
      apply: async () => ({ status: 'applied', rule: action.ownedRule, backupPath: action.backupPath, preFingerprint: 'before', postFingerprint: 'after' }),
      createAction: () => action,
    });
    expect(result).toEqual({ ok: true });
    expect(store.recordGlobalAction).toHaveBeenCalledWith(action);
  });

  it('rejects a locked rollout for Claude and Codex before applying', async () => {
    for (const client of ['claude-code', 'codex'] as const) {
      const apply = vi.fn();
      const result = await disableGlobally({
        store: eligibleStore() as any,
        target: { client, serverName: 'docs', toolName: 'search', definitionSetHash: action.definitionSetHash },
        rolloutAllowed: false, analysisRulesVersion: 1, apply,
      });
      expect(result.ok).toBe(false);
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['calls', { callsSince: () => [{ serverName: 'docs', toolName: 'search' }] }],
    ['confidence', { sessionsSince: () => [] }],
    ['collection health', { collectionHealthByClient: () => new Map([['claude-code', { health: 'degraded' }]]) }],
    ['recent restore', { hasRestoredActionSince: () => true }],
  ])('rejects ineligible %s before applying', async (_name, overrides) => {
    const apply = vi.fn();
    const result = await disableGlobally({
      store: eligibleStore(overrides) as any,
      target: { client: 'claude-code', serverName: 'docs', toolName: 'search', definitionSetHash: action.definitionSetHash },
      rolloutAllowed: true, analysisRulesVersion: 1, apply,
    });
    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['target client has no configured server', { serversByClient: () => new Map([['codex', new Set(['docs'])]]) }],
    ['target client has no identity', { serverIdentities: () => [{ client: 'codex', conflictState: 'clear', endpointHash: 'identity' }] }],
    ['global identity collision', { serverIdentities: () => [
      { client: 'claude-code', conflictState: 'clear', endpointHash: 'identity' },
      { client: 'codex', conflictState: 'clear', endpointHash: 'other' },
    ] }],
  ])('rejects %s before applying', async (_name, overrides) => {
    const apply = vi.fn();
    const result = await disableGlobally({
      store: eligibleStore(overrides) as any,
      target: { client: 'claude-code', serverName: 'docs', toolName: 'search', definitionSetHash: action.definitionSetHash },
      rolloutAllowed: true, analysisRulesVersion: 1, apply,
    });
    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a forged Gemini target before applying', async () => {
    const apply = vi.fn();
    const result = await disableGlobally({
      store: eligibleStore({
        serversByClient: () => new Map([['gemini-cli', new Set(['docs'])]]),
        serverIdentities: () => [{ client: 'gemini-cli', conflictState: 'clear', endpointHash: 'identity' }],
        collectionHealthByClient: () => new Map([['gemini-cli', { health: 'healthy' }]]),
      }) as any,
      target: { client: 'gemini-cli', serverName: 'docs', toolName: 'search', definitionSetHash: action.definitionSetHash } as any,
      rolloutAllowed: true, analysisRulesVersion: 1, apply,
    });
    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('marks a restore fingerprint conflict without claiming restoration', async () => {
    const updateGlobalActionStatus = vi.fn();
    const result = await restoreGlobally({
      store: { updateGlobalActionStatus, save: vi.fn() } as any, action,
      rolloutAllowed: true, restore: async () => ({ status: 'conflict', rule: action.ownedRule }),
    });
    expect(result).toEqual({ ok: false, message: 'Configuration changed outside MCP Lens. Restore was not applied.' });
    expect(updateGlobalActionStatus).toHaveBeenCalledWith(action.actionId, 'conflict');
  });
});
