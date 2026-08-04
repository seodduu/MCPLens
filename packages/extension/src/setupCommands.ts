import * as vscode from 'vscode';
import type { LensStore } from '@mcp-lens/core';
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
