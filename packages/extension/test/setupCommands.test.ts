import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_TITLE } from '../src/automationConsent.js';

const showInformationMessage = vi.fn();
const showErrorMessage = vi.fn();
const showInputBox = vi.fn();
const updateConfig = vi.fn();
const executeCommand = vi.fn();

/** Global values of the settings, rewritten per test. undefined means the setting was never written. */
let globals: Record<string, unknown> = {};
/** Every registered command handler, keyed by command id. */
const handlers = new Map<string, (arg?: unknown) => Promise<void>>();
/** The command handler registered under mcp-lens.openRolloutSetting. */
let registered: (() => Promise<void>) | undefined;

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => globals[key] ?? fallback,
      inspect: (key: string) => ({ globalValue: globals[key] }),
      update: updateConfig,
    }),
  },
  window: { showInformationMessage, showErrorMessage, showInputBox },
  env: { openExternal: vi.fn() },
  Uri: { parse: (value: string) => value },
  commands: {
    registerCommand: (id: string, handler: (arg?: unknown) => Promise<void>) => {
      handlers.set(id, handler);
      if (id === 'mcp-lens.openRolloutSetting') registered = handler as () => Promise<void>;
      return { dispose: vi.fn() };
    },
    executeCommand,
  },
  ConfigurationTarget: { Global: 1 },
  Disposable: { from: () => ({ dispose: vi.fn() }) },
}));

const authenticateServerMock = vi.fn();
const collectAllSpecsMock = vi.fn();
const readOAuthClientsMock = vi.fn();
const saveOAuthClientMock = vi.fn();

vi.mock('@mcp-lens/core', () => ({
  authenticateServer: (...args: unknown[]) => authenticateServerMock(...args),
  collectAllSpecs: () => collectAllSpecsMock(),
  readOAuthClients: () => readOAuthClientsMock(),
  saveOAuthClient: (...args: unknown[]) => saveOAuthClientMock(...args),
}));

/** What core throws when a server refuses to register Lens as a client. */
function registrationRequired(): Error {
  const err = new Error('github does not allow automatic client registration.');
  err.name = 'ClientRegistrationRequiredError';
  return err;
}

async function runOpenRolloutSetting(): Promise<void> {
  const { registerOpenRolloutSetting } = await import('../src/setupCommands.js');
  registerOpenRolloutSetting();
  await registered!();
}

describe('automation consent on the last onboarding step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globals = {};
    registered = undefined;
  });

  /**
   * The regression this guards. autoScan is also written by the automatic scan prompt (autoScan.ts),
   * which never writes autoAnalyze. Keying the "already asked" test on autoScan made that prompt
   * silently consume this question, so automatic analysis stayed off with no consent ever collected.
   */
  it('still asks when only autoScan was written, by the scan prompt', async () => {
    globals = { autoScan: 'always' };
    showInformationMessage.mockResolvedValue(AUTOMATION_ACCEPT_LABEL);

    await runOpenRolloutSetting();

    expect(showInformationMessage).toHaveBeenCalledWith(
      AUTOMATION_PROMPT_TITLE, expect.objectContaining({ modal: true }), expect.anything(), expect.anything());
    expect(updateConfig).toHaveBeenCalledWith('autoAnalyze', true, 1);
  });

  it('does not ask again once autoAnalyze was written', async () => {
    globals = { autoScan: 'always', autoAnalyze: false };

    await runOpenRolloutSetting();

    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('opens the rollout setting either way', async () => {
    globals = { autoScan: 'always', autoAnalyze: true };

    await runOpenRolloutSetting();

    expect(executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings', 'mcplens.dependencyAnalysis.rollout');
  });
});

describe('signing in from the Setup Status view', () => {
  const refresh = vi.fn();

  async function runAuthenticate(arg: unknown): Promise<void> {
    const { registerAuthenticateServer } = await import('../src/setupCommands.js');
    registerAuthenticateServer(refresh);
    await handlers.get('mcp-lens.authenticateServer')!(arg);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    globals = {};
    handlers.clear();
    collectAllSpecsMock.mockReturnValue({ specs: [{ name: 'github' }] });
    authenticateServerMock.mockResolvedValue(undefined);
    readOAuthClientsMock.mockReturnValue({});
  });

  it('reads the server name from a row click argument', async () => {
    await runAuthenticate({ serverName: 'github' });

    expect(authenticateServerMock).toHaveBeenCalledWith({ name: 'github' }, expect.anything());
  });

  /** The inline hover button passes the tree element, not the row-click argument shape. */
  it('reads the server name from an inline button tree node', async () => {
    await runAuthenticate({ kind: 'row', row: { label: 'github' } });

    expect(authenticateServerMock).toHaveBeenCalledWith({ name: 'github' }, expect.anything());
  });

  it('lifts the ignore suppression after a successful sign-in', async () => {
    globals = { authIgnore: ['github', 'vercel'] };

    await runAuthenticate({ kind: 'row', row: { label: 'github' } });

    expect(updateConfig).toHaveBeenCalledWith('authIgnore', ['vercel'], 1);
  });

  /** The inline text button of an ignored row uses a second id whose short title renders as text. */
  it('registers the ignored-row id with the same behaviour', async () => {
    globals = { authIgnore: ['github'] };
    const { registerAuthenticateServer } = await import('../src/setupCommands.js');
    registerAuthenticateServer(refresh);

    await handlers.get('mcp-lens.signInIgnoredServer')!({ kind: 'row', row: { label: 'github' } });

    expect(authenticateServerMock).toHaveBeenCalledWith({ name: 'github' }, expect.anything());
    expect(updateConfig).toHaveBeenCalledWith('authIgnore', [], 1);
  });

  it('keeps the ignore list when the sign-in fails', async () => {
    globals = { authIgnore: ['github'] };
    authenticateServerMock.mockRejectedValue(new Error('nope'));

    await runAuthenticate({ kind: 'row', row: { label: 'github' } });

    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('passes the client id from the setting, with the secret from the shared file', async () => {
    globals = { oauthClients: { github: 'Iv1.setting' } };
    readOAuthClientsMock.mockReturnValue({ github: { clientId: 'Iv1.file', clientSecret: 's3cr3t' } });

    await runAuthenticate({ serverName: 'github' });

    expect(authenticateServerMock).toHaveBeenCalledWith(
      { name: 'github' },
      expect.objectContaining({ client: { clientId: 'Iv1.setting', clientSecret: 's3cr3t' } }));
  });

  it('falls back to the shared file when the setting has no entry', async () => {
    readOAuthClientsMock.mockReturnValue({ github: { clientId: 'Iv1.file' } });

    await runAuthenticate({ serverName: 'github' });

    expect(authenticateServerMock).toHaveBeenCalledWith(
      { name: 'github' }, expect.objectContaining({ client: { clientId: 'Iv1.file' } }));
  });

  /**
   * The regression this guards: GitHub and Figma refuse dynamic registration, so without this
   * prompt their rows could only ever report the raw SDK error and never sign in.
   */
  it('asks for a client id when registration is refused, then retries and saves it', async () => {
    authenticateServerMock.mockRejectedValueOnce(registrationRequired()).mockResolvedValueOnce(undefined);
    showInputBox.mockResolvedValueOnce('Iv1.typed').mockResolvedValueOnce('typed-secret');

    await runAuthenticate({ serverName: 'github' });

    expect(saveOAuthClientMock).toHaveBeenCalledWith(
      'github', { clientId: 'Iv1.typed', clientSecret: 'typed-secret' });
    expect(authenticateServerMock).toHaveBeenLastCalledWith(
      { name: 'github' },
      expect.objectContaining({ client: { clientId: 'Iv1.typed', clientSecret: 'typed-secret' } }));
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('treats an empty secret as a public PKCE-only client', async () => {
    authenticateServerMock.mockRejectedValueOnce(registrationRequired()).mockResolvedValueOnce(undefined);
    showInputBox.mockResolvedValueOnce('Iv1.typed').mockResolvedValueOnce('');

    await runAuthenticate({ serverName: 'github' });

    expect(saveOAuthClientMock).toHaveBeenCalledWith('github', { clientId: 'Iv1.typed' });
  });

  it('gives up quietly when the client id prompt is dismissed', async () => {
    authenticateServerMock.mockRejectedValueOnce(registrationRequired());
    showInputBox.mockResolvedValueOnce(undefined);

    await runAuthenticate({ serverName: 'github' });

    expect(saveOAuthClientMock).not.toHaveBeenCalled();
    expect(authenticateServerMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failure that is not about registration without prompting', async () => {
    authenticateServerMock.mockRejectedValue(new Error('oauth callback timeout'));

    await runAuthenticate({ serverName: 'github' });

    expect(showInputBox).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'MCP Lens: sign-in failed for github: oauth callback timeout');
  });
});
