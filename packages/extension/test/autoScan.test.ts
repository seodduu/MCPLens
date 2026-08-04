import { describe, it, expect, vi, beforeEach } from 'vitest';

const showInformationMessage = vi.fn();
const updateConfig = vi.fn();
const upsertClientServers = vi.fn();
const upsertScanResult = vi.fn();
const upsertDefinitions = vi.fn();
const save = vi.fn();

const result = {
  definitions: [{
    serverName: 'srv',
    toolName: 'tool',
    definitionTokens: 7,
    scannedAt: '2026-08-03T00:00:00.000Z',
    firstScannedAt: '2026-08-03T00:00:00.000Z',
  }],
  bodies: [{
    serverName: 'srv',
    toolName: 'tool',
    description: 'Tool body',
    inputSchemaJson: '{}',
    definitionTokens: 7,
    definitionSetHash: 'a'.repeat(64),
    scannedAt: '2026-08-03T00:00:00.000Z',
  }],
};
const identities = [{
  client: 'codex',
  serverName: 'srv',
  sourceKind: 'codex',
  sourcePathHash: 'b'.repeat(64),
  transport: 'stdio',
  endpointHash: 'c'.repeat(64),
  conflictState: 'clear',
  observedAt: '2026-08-03T00:00:00.000Z',
}];

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => {
        if (key === 'autoScan') return 'always';
        return fallback;
      },
      update: updateConfig,
    }),
  },
  window: {
    showInformationMessage,
    setStatusBarMessage: vi.fn(),
  },
  ConfigurationTarget: { Global: 1 },
  env: { openExternal: vi.fn() },
  Uri: { parse: (value: string) => value },
}));

vi.mock('@mcp-lens/core', () => ({
  collectAllSpecs: () => ({
    specs: [{ name: 'srv', command: 'cmd', args: [] }],
    skipped: [],
    attribution: new Map([['srv', new Set(['codex'])]]),
    replaceable: new Set(['codex']),
    identities,
  }),
  configSources: () => [],
  scanServer: vi.fn(async () => result),
  authenticateServer: vi.fn(),
}));

describe('maybeAutoScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activation scan persists definitions, bodies, and identities in one scan result', async () => {
    const { maybeAutoScan } = await import('../src/autoScan.js');
    await maybeAutoScan({
      upsertClientServers,
      allDefinitions: () => [],
      serversWithDefinitionBodies: () => new Set(),
      upsertScanResult,
      upsertDefinitions,
      save,
    } as any, vi.fn());

    expect(upsertScanResult).toHaveBeenCalledWith(result.definitions, result.bodies, identities);
    expect(upsertDefinitions).not.toHaveBeenCalled();
    expect(upsertClientServers).toHaveBeenCalledOnce();
  });

  it('definition만 있고 body가 없으면 활성화 시 재스캔한다', async () => {
    const { maybeAutoScan } = await import('../src/autoScan.js');
    // definition은 이미 있지만(레거시 DB) body가 없는 상황을 재현한다.
    // serversWithDefinitionBodies가 빈 집합을 돌려주면 판정이 재스캔 대상으로 봐야 한다.
    await maybeAutoScan({
      upsertClientServers,
      allDefinitions: () => [{ serverName: 'srv', toolName: 'tool', definitionTokens: 7,
        scannedAt: '2026-08-01T00:00:00.000Z', firstScannedAt: '2026-08-01T00:00:00.000Z' }],
      serversWithDefinitionBodies: () => new Set(),
      upsertScanResult,
      upsertDefinitions,
      save,
    } as any, vi.fn());

    expect(upsertScanResult).toHaveBeenCalledWith(result.definitions, result.bodies, identities);
  });
});
