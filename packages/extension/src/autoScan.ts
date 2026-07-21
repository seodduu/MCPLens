// packages/extension/src/autoScan.ts
import * as vscode from 'vscode';
import { watchFile, unwatchFile } from 'node:fs';
import {
  collectAllSpecs, configSources, scanServer, authenticateServer,
  type LensStore, type McpServerSpec,
} from '@mcp-lens/core';
import { decideScanAction, type AutoScanSetting } from './scanDecision.js';
import { decideAuthPrompt, friendlyAuthError, isDcrRejected } from './authDecision.js';

/** Lens가 지원하지 않는다고 판정한 서버명(설정에 영구 저장). DCR 거부 서버 등. */
const unsupportedServers = (config: vscode.WorkspaceConfiguration): string[] =>
  config.get<string[]>('unsupportedServers', []);

/**
 * '나중에'로 이번 세션 동안 로그인 알림을 억제한 서버 이름.
 * 모듈 스코프라 확장 활성화(=VSCode 창) 수명과 함께 살고 재시작 시 초기화된다 —
 * '나중에 → VSCode 재시작 전까지 알림 없음' 요구를 만족한다. (영구 무시는 authIgnore 설정)
 */
const sessionAuthSnooze = new Set<string>();

async function runScan(store: LensStore, targets: McpServerSpec[],
  onDone: () => void): Promise<void> {
  let tools = 0, tokens = 0, failed: string[] = [], authFailed: McpServerSpec[] = [];
  for (const spec of targets) {
    try {
      const defs = await scanServer(spec);
      store.upsertDefinitions(defs);
      tools += defs.length;
      tokens += defs.reduce((s, d) => s + d.definitionTokens, 0);
    } catch (err) {
      failed.push(spec.name);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('auth-required') || msg.includes('token-expired')) authFailed.push(spec);
    }
  }
  store.save();
  onDone(); // refresh() — 상태바·사이드바 ?tok 갱신
  const failNote = failed.length ? ` (실패: ${failed.join(', ')})` : '';
  vscode.window.setStatusBarMessage(
    `$(check) Lens: ${targets.length - failed.length}개 서버 · 툴 ${tools}개 · ${tokens}tok 스캔 완료${failNote}`, 8000);
  if (authFailed.length) await maybeAuthPrompt(store, authFailed, onDone);
}

/** 스캔 후 auth-required/token-expired 실패 서버에 대해 로그인 동의창 1개를 띄운다. */
export async function maybeAuthPrompt(
  store: LensStore, failedServers: McpServerSpec[], onDone: () => void,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('mcpLens');
  const ignoreList = config.get<string[]>('authIgnore', []);
  const action = decideAuthPrompt({
    failedServers, ignoreList,
    sessionSnoozed: [...sessionAuthSnooze], unsupported: unsupportedServers(config) });
  if (action.kind === 'skip') return;

  const names = action.targets.map((t) => t.name).join(', ');
  const pick = await vscode.window.showInformationMessage(
    `MCP 서버 ${action.targets.length}개(${names})는 로그인이 필요합니다. ` +
    `브라우저에서 로그인할까요? (Lens 명의로 접근 권한을 요청합니다)`,
    '로그인', '나중에', '이 서버는 묻지 않음');

  if (pick === '로그인') {
    const errors: string[] = [];
    const unsupported: string[] = [];
    for (const spec of action.targets) {
      try {
        await authenticateServer(spec, {
          openUrl: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
        });
        const defs = await scanServer(spec);
        store.upsertDefinitions(defs);
      } catch (err) {
        // DCR 거부 서버(예: Figma)는 브라우저가 열리기도 전에 실패한다 — Lens가 지원할 수 없으므로
        // '지원하지 않는 서버'로 영구 등록해 트리에서 숨기고 다시는 로그인을 묻지 않는다.
        if (isDcrRejected(err)) unsupported.push(spec.name);
        else errors.push(`${spec.name}: ${friendlyAuthError(err)}`); // 그 외 실패는 원인 표면화
      }
    }
    store.save();
    if (unsupported.length) {
      const merged = [...new Set([...unsupportedServers(config), ...unsupported])];
      await config.update('unsupportedServers', merged, vscode.ConfigurationTarget.Global);
      void vscode.window.showWarningMessage(
        `MCP Lens는 다음 MCP를 지원하지 않습니다: ${unsupported.join(', ')}`);
    }
    onDone(); // 트리 새로고침 — unsupported 반영해 숨긴다
    if (errors.length) void vscode.window.showErrorMessage(errors.join('\n'));
  } else if (pick === '이 서버는 묻지 않음') {
    const names2 = action.targets.map((t) => t.name);
    await config.update('authIgnore', [...ignoreList, ...names2], vscode.ConfigurationTarget.Global);
  } else if (pick === '나중에') {
    // 이번 VSCode 세션 동안만 억제 — 재시작하면 다시 묻는다.
    for (const t of action.targets) sessionAuthSnooze.add(t.name);
  } // 닫기(undefined) → 아무것도 저장 안 함 → 다음 스캔 때 다시 묻는다
}

export async function maybeAutoScan(store: LensStore, onDone: () => void): Promise<void> {
  const { specs, attribution, replaceable } = collectAllSpecs();
  // 귀속은 설정 파일만 읽으면 되므로 서버 스캔 성공 여부와 무관하게 저장한다.
  // 자동 스캔을 건너뛰는 경우(action.kind === 'skip')에도 매핑은 최신이어야 한다.
  store.upsertClientServers(attribution, replaceable);
  store.save(); // run()은 자동 저장하지 않는다 — 여기서 저장 안 하면 skip 경로(정상 정착 상태의 기본값)에서
                // 매핑이 디스크에 반영되지 않고 다음 활성화 때 다시 빈 매핑으로 보인다.
  const config = vscode.workspace.getConfiguration('mcpLens');
  const setting = config.get<AutoScanSetting>('autoScan', 'prompt');
  const knownServers = new Set(store.allDefinitions().map((d) => d.serverName));
  const action = decideScanAction({
    setting, specs, knownServers, unsupported: new Set(unsupportedServers(config)) });

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

/** 전 소스(claude-user/project, codex, gemini) 설정 파일 변경 감시 → 디바운스 후 재판정. dispose 반환. */
export function watchConfigSources(store: LensStore, onDone: () => void): vscode.Disposable {
  const paths = configSources().map((s) => s.filePath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void maybeAutoScan(store, onDone), 2000); // 저장 연타 흡수
  };
  for (const p of paths) watchFile(p, { interval: 5000 }, listener);
  return {
    dispose: () => {
      clearTimeout(timer);
      for (const p of paths) unwatchFile(p, listener);
    },
  };
}
