import * as vscode from 'vscode';
import { authenticateServer, collectAllSpecs, type LensStore } from '@mcp-lens/core';
import { scanNow, type AfterScan } from './autoScan.js';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_PROMPT_TITLE,
  AUTOMATION_SCAN_ONLY_LABEL, automationChoiceFrom, automationSettings,
} from './automationConsent.js';

/** The command the "Scan servers" button of the onboarding walkthrough points at. */
export function registerScanNow(store: () => LensStore, refresh: () => void, afterScan?: AfterScan): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.scanNow', async () => {
    try {
      await scanNow(store(), refresh, afterScan);
    } catch (err) {
      // store.save() throws StaleWriterError unless this window holds the writer lease.
      // This is the walkthrough's primary button, so the raw extension host error becomes guidance.
      if (err instanceof Error && err.name === 'StaleWriterError') {
        void vscode.window.showInformationMessage(
          'MCP Lens: another VS Code window is currently writing to the Lens database. Try again in a moment.');
        return;
      }
      throw err;
    }
  });
}

/**
 * The command the "Open Global Actions setting" button of the onboarding walkthrough points at.
 *
 * Before opening the setting, consent for handling new servers automatically is collected once. It
 * is the last onboarding step, after the user has chosen a provider and finished an analysis, so
 * they have already experienced what they are consenting to. The answer is written to settings and never asked again.
 */
export function registerOpenRolloutSetting(): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.openRolloutSetting', async () => {
    await askAutomationConsentOnce();
    await vscode.commands.executeCommand(
      'workbench.action.openSettings', 'mcplens.dependencyAnalysis.rollout');
  });
}

/** Never asks again once answered. The test is whether the setting is explicitly written. */
async function askAutomationConsentOnce(): Promise<void> {
  const config = vscode.workspace.getConfiguration('mcpLens');
  if (config.inspect<string>('autoScan')?.globalValue !== undefined) return;

  const pick = await vscode.window.showInformationMessage(
    AUTOMATION_PROMPT_TITLE,
    { modal: true, detail: AUTOMATION_PROMPT_DETAIL },
    AUTOMATION_ACCEPT_LABEL, AUTOMATION_SCAN_ONLY_LABEL);
  const settings = automationSettings(automationChoiceFrom(pick));
  await config.update('autoScan', settings.autoScan, vscode.ConfigurationTarget.Global);
  await config.update('autoAnalyze', settings.autoAnalyze, vscode.ConfigurationTarget.Global);
}

/**
 * Command used only by the "sign in to scan" row of the Setup Status view. Hidden from the palette
 * (when: false) because there is no way to run it without a server name argument. It follows exactly
 * the call style of maybeAuthPrompt in autoScan.ts (openUrl -> vscode.env.openExternal).
 */
export function registerAuthenticateServer(refresh: () => void): vscode.Disposable {
  return vscode.commands.registerCommand(
    'mcp-lens.authenticateServer', async (node?: { serverName?: string }) => {
      const serverName = node?.serverName;
      if (!serverName) return;
      const { specs } = collectAllSpecs();
      const spec = specs.find((s) => s.name === serverName);
      if (!spec) return;
      try {
        await authenticateServer(spec, {
          openUrl: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
        });
        void vscode.window.showInformationMessage(`MCP Lens: signed in to ${serverName}. Run a scan to pick it up.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`MCP Lens: sign-in failed for ${serverName}: ${msg}`);
      }
      refresh();
    });
}
