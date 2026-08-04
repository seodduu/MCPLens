import * as vscode from 'vscode';
import { authenticateServer, collectAllSpecs, type LensStore } from '@mcp-lens/core';
import { scanNow } from './autoScan.js';

/** 온보딩 워크스루의 "Scan servers" 버튼이 가리키는 커맨드. */
export function registerScanNow(store: () => LensStore, refresh: () => void): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.scanNow', () => scanNow(store(), refresh));
}

/** 온보딩 워크스루의 "Open Global Actions setting" 버튼이 가리키는 커맨드. */
export function registerOpenRolloutSetting(): vscode.Disposable {
  return vscode.commands.registerCommand('mcp-lens.openRolloutSetting', () =>
    vscode.commands.executeCommand(
      'workbench.action.openSettings', 'mcplens.dependencyAnalysis.rollout'));
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
