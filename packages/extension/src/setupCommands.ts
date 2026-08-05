import * as vscode from 'vscode';
import { authenticateServer, collectAllSpecs, type LensStore } from '@mcp-lens/core';
import { scanNow, type AfterScan } from './autoScan.js';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_PROMPT_TITLE,
  AUTOMATION_SCAN_ONLY_LABEL, automationChoiceFrom, automationSettings,
} from './automationConsent.js';

/** 온보딩 워크스루의 "Scan servers" 버튼이 가리키는 커맨드. */
export function registerScanNow(store: () => LensStore, refresh: () => void, afterScan?: AfterScan): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.scanNow', async () => {
    try {
      await scanNow(store(), refresh, afterScan);
    } catch (err) {
      // store.save()는 이 창이 writer 리스를 쥐고 있지 않으면 StaleWriterError를 던진다.
      // 워크스루의 주 버튼이라 원본 익스텐션 호스트 에러를 그대로 노출하지 않고 안내로 바꾼다.
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
 * 온보딩 워크스루의 "Open Global Actions setting" 버튼이 가리키는 커맨드.
 *
 * 설정을 열기 전에 새 서버 자동 처리 동의를 한 번 받는다. 온보딩의 마지막 단계라
 * 사용자가 제공자를 고르고 분석까지 마친 뒤이므로, 무엇에 동의하는지 이미 겪어 본
 * 시점이다. 답은 설정에 적히고 이후로는 다시 묻지 않는다.
 */
export function registerOpenRolloutSetting(): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.openRolloutSetting', async () => {
    await askAutomationConsentOnce();
    await vscode.commands.executeCommand(
      'workbench.action.openSettings', 'mcplens.dependencyAnalysis.rollout');
  });
}

/** 이미 답한 적이 있으면 묻지 않는다. 판정은 설정이 명시적으로 적혀 있는가로 한다. */
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
 * Setup Status 뷰의 "sign in to scan" 행 클릭 전용 커맨드. 팔레트에서는 숨긴다(when: false) —
 * 서버 이름 인자 없이 실행할 방법이 없기 때문이다. autoScan.ts의 maybeAuthPrompt와 같은
 * 호출 방식(openUrl → vscode.env.openExternal)을 그대로 따른다.
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
