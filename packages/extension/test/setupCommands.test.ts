import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_TITLE } from '../src/automationConsent.js';

const showInformationMessage = vi.fn();
const updateConfig = vi.fn();
const executeCommand = vi.fn();

/** Global values of the settings, rewritten per test. undefined means the setting was never written. */
let globals: Record<string, unknown> = {};
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
  window: { showInformationMessage },
  commands: {
    registerCommand: (id: string, handler: () => Promise<void>) => {
      if (id === 'mcp-lens.openRolloutSetting') registered = handler;
      return { dispose: vi.fn() };
    },
    executeCommand,
  },
  ConfigurationTarget: { Global: 1 },
}));

vi.mock('@mcp-lens/core', () => ({
  authenticateServer: vi.fn(),
  collectAllSpecs: vi.fn(),
}));

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
