import { describe, it, expect, vi, beforeEach } from 'vitest';

const showInformationMessage = vi.fn();
const updateConfig = vi.fn();
const upsertClientServers = vi.fn();
const upsertScanResult = vi.fn();
const upsertDefinitions = vi.fn();
const save = vi.fn();
const recordServerScanStatus = vi.fn();

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
    showErrorMessage: vi.fn(),
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
    // Automatic scanning does not run on the first run (0 definitions), so this sets up a DB
    // already in use that just gained a new server.
    await maybeAutoScan({
      upsertClientServers,
      allDefinitions: () => [{ serverName: 'already', toolName: 'tool', definitionTokens: 5,
        scannedAt: '2026-08-01T00:00:00Z', firstScannedAt: '2026-08-01T00:00:00Z' }],
      serversWithDefinitionBodies: () => new Set(['already']),
      upsertScanResult,
      upsertDefinitions,
      recordServerScanStatus,
      save,
    } as any, vi.fn());

    expect(upsertScanResult).toHaveBeenCalledWith(result.definitions, result.bodies, identities);
    expect(upsertDefinitions).not.toHaveBeenCalled();
    expect(upsertClientServers).toHaveBeenCalledOnce();
  });

  it('rescans on activation when definitions exist but bodies do not', async () => {
    const { maybeAutoScan } = await import('../src/autoScan.js');
    // Reproduces a legacy DB where definitions already exist but bodies do not.
    // With serversWithDefinitionBodies returning an empty set, the verdict must treat it as a rescan target.
    await maybeAutoScan({
      upsertClientServers,
      allDefinitions: () => [{ serverName: 'srv', toolName: 'tool', definitionTokens: 7,
        scannedAt: '2026-08-01T00:00:00.000Z', firstScannedAt: '2026-08-01T00:00:00.000Z' }],
      serversWithDefinitionBodies: () => new Set(),
      upsertScanResult,
      upsertDefinitions,
      recordServerScanStatus,
      save,
    } as any, vi.fn());

    expect(upsertScanResult).toHaveBeenCalledWith(result.definitions, result.bodies, identities);
  });
});

describe('per-server scan status recording in runScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Automatic scanning does not run on the first run (0 definitions). What matters here is the next
  // stage, "an existing user gains a new server", so one existing definition is seeded.
  const store = () => ({
    upsertClientServers,
    allDefinitions: () => [{ serverName: 'already', toolName: 'tool', definitionTokens: 5,
      scannedAt: '2026-08-01T00:00:00Z', firstScannedAt: '2026-08-01T00:00:00Z' }],
    serversWithDefinitionBodies: () => new Set(['already']),
    upsertScanResult,
    upsertDefinitions,
    recordServerScanStatus,
    save,
  } as any);

  it('records a successfully scanned server as ok', async () => {
    const { maybeAutoScan } = await import('../src/autoScan.js');
    await maybeAutoScan(store(), vi.fn());

    expect(recordServerScanStatus).toHaveBeenCalledWith('srv', 'ok', expect.any(String));
  });

  it('records an auth-required exception as auth-required with no errorCode', async () => {
    const { scanServer } = await import('@mcp-lens/core');
    (scanServer as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('auth-required'));

    const { maybeAutoScan } = await import('../src/autoScan.js');
    await maybeAutoScan(store(), vi.fn());

    expect(recordServerScanStatus).toHaveBeenCalledWith('srv', 'auth-required', expect.any(String), undefined);
  });

  it('records other exceptions as failed with an errorCode of at most 120 characters', async () => {
    const { scanServer } = await import('@mcp-lens/core');
    const longMessage = 'boom'.repeat(50); // 200 characters
    (scanServer as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(longMessage));

    const { maybeAutoScan } = await import('../src/autoScan.js');
    await maybeAutoScan(store(), vi.fn());

    expect(recordServerScanStatus).toHaveBeenCalledWith('srv', 'failed', expect.any(String), expect.any(String));
    const errorCode = recordServerScanStatus.mock.calls[0][3] as string;
    expect(errorCode.length).toBeLessThanOrEqual(120);
  });
});

describe('post-login rescan status recording in maybeAuthPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const spec = { name: 'srv', command: 'cmd', args: [] };
  // Automatic scanning does not run on the first run (0 definitions). What matters here is the next
  // stage, "an existing user gains a new server", so one existing definition is seeded.
  const store = () => ({
    upsertClientServers,
    allDefinitions: () => [{ serverName: 'already', toolName: 'tool', definitionTokens: 5,
      scannedAt: '2026-08-01T00:00:00Z', firstScannedAt: '2026-08-01T00:00:00Z' }],
    serversWithDefinitionBodies: () => new Set(['already']),
    upsertScanResult,
    upsertDefinitions,
    recordServerScanStatus,
    save,
  } as any);

  it('records the server as ok once the login succeeds and the rescan finishes', async () => {
    showInformationMessage.mockResolvedValueOnce('Sign in');
    const { authenticateServer, scanServer } = await import('@mcp-lens/core');
    (authenticateServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    (scanServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(result);

    const { maybeAuthPrompt } = await import('../src/autoScan.js');
    await maybeAuthPrompt(store(), [spec], vi.fn());

    expect(recordServerScanStatus).toHaveBeenCalledWith('srv', 'ok', expect.any(String));
  });

  it('records auth-required with no errorCode when the rescan fails with auth-required again', async () => {
    showInformationMessage.mockResolvedValueOnce('Sign in');
    const { authenticateServer, scanServer } = await import('@mcp-lens/core');
    (authenticateServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    (scanServer as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('token-expired'));

    const { maybeAuthPrompt } = await import('../src/autoScan.js');
    await maybeAuthPrompt(store(), [spec], vi.fn());

    expect(recordServerScanStatus).toHaveBeenCalledWith(
      'srv', 'auth-required', expect.any(String), undefined);
  });

  it('records failed with an errorCode of at most 120 characters when the rescan fails otherwise', async () => {
    showInformationMessage.mockResolvedValueOnce('Sign in');
    const { authenticateServer, scanServer } = await import('@mcp-lens/core');
    (authenticateServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const longMessage = 'boom'.repeat(50); // 200 characters
    (scanServer as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(longMessage));

    const { maybeAuthPrompt } = await import('../src/autoScan.js');
    await maybeAuthPrompt(store(), [spec], vi.fn());

    expect(recordServerScanStatus).toHaveBeenCalledWith(
      'srv', 'failed', expect.any(String), expect.any(String));
    const call = recordServerScanStatus.mock.calls.find((c) => c[1] === 'failed');
    const errorCode = call?.[3] as string;
    expect(errorCode.length).toBeLessThanOrEqual(120);
  });
});
