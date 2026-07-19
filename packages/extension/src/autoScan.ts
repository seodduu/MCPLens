// packages/extension/src/autoScan.ts
import * as vscode from 'vscode';
import { watchFile, unwatchFile, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectServerSpecs, scanServer, type LensStore, type McpServerSpec } from '@mcp-lens/core';
import { decideScanAction, type AutoScanSetting } from './scanDecision.js';

export function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

async function runScan(store: LensStore, targets: McpServerSpec[],
  onDone: () => void): Promise<void> {
  let tools = 0, tokens = 0, failed: string[] = [];
  for (const spec of targets) {
    try {
      const defs = await scanServer(spec);
      store.upsertDefinitions(defs);
      tools += defs.length;
      tokens += defs.reduce((s, d) => s + d.definitionTokens, 0);
    } catch { failed.push(spec.name); }
  }
  store.save();
  onDone(); // refresh() — 상태바·사이드바 ?tok 갱신
  const failNote = failed.length ? ` (실패: ${failed.join(', ')})` : '';
  vscode.window.setStatusBarMessage(
    `$(check) Lens: ${targets.length - failed.length}개 서버 · 툴 ${tools}개 · ${tokens}tok 스캔 완료${failNote}`, 8000);
}

export async function maybeAutoScan(store: LensStore, onDone: () => void): Promise<void> {
  const cfgPath = claudeConfigPath();
  if (!existsSync(cfgPath)) return;
  const { specs } = collectServerSpecs(readFileSync(cfgPath, 'utf8'));
  const config = vscode.workspace.getConfiguration('mcpLens');
  const setting = config.get<AutoScanSetting>('autoScan', 'prompt');
  const knownServers = new Set(store.allDefinitions().map((d) => d.serverName));
  const action = decideScanAction({ setting, specs, knownServers });

  if (action.kind === 'skip') return;
  if (action.kind === 'scan') return runScan(store, action.targets, onDone);

  // kind === 'prompt' — 합의된 동의창
  const names = action.targets.map((t) => t.name).join(', ');
  const pick = await vscode.window.showInformationMessage(
    `MCP Lens: MCP 서버 ${action.targets.length}개(${names})의 툴 정의를 스캔할까요? ` +
    `서버를 잠깐 실행합니다. (토큰 소모 없음 · 설정 변경 없음)`,
    '스캔', '나중에', '다시 묻지 않음');
  if (pick === '스캔') {
    await config.update('autoScan', 'always', vscode.ConfigurationTarget.Global);
    await runScan(store, action.targets, onDone);
  } else if (pick === '다시 묻지 않음') {
    await config.update('autoScan', 'never', vscode.ConfigurationTarget.Global);
  } // '나중에'/닫기 → 아무것도 저장 안 함 → 다음 시작 때 재질문
}

/** ~/.claude.json 변경 감시 → 디바운스 후 재판정. dispose 반환. */
export function watchClaudeConfig(store: LensStore, onDone: () => void): vscode.Disposable {
  const cfgPath = claudeConfigPath();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void maybeAutoScan(store, onDone), 2000); // 저장 연타 흡수
  };
  watchFile(cfgPath, { interval: 5000 }, listener);
  return { dispose: () => { clearTimeout(timer); unwatchFile(cfgPath, listener); } };
}
