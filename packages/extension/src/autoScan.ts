// packages/extension/src/autoScan.ts
import * as vscode from 'vscode';
import { watchFile, unwatchFile } from 'node:fs';
import {
  collectAllSpecs, configSources, scanServer, authenticateServer,
  type LensStore, type McpServerSpec, type ServerIdentity,
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
  onDone: () => void, identities: readonly ServerIdentity[] = []): Promise<void> {
  let tools = 0, tokens = 0, failed: string[] = [], authFailed: McpServerSpec[] = [];
  for (const spec of targets) {
    const observedAt = new Date().toISOString();
    try {
      const result = await scanServer(spec);
      store.upsertScanResult(
        result.definitions,
        result.bodies,
        identities.filter((identity) => identity.serverName === spec.name),
      );
      store.recordServerScanStatus(spec.name, 'ok', observedAt);
      tools += result.definitions.length;
      tokens += result.definitions.reduce((s, d) => s + d.definitionTokens, 0);
    } catch (err) {
      failed.push(spec.name);
      const msg = err instanceof Error ? err.message : String(err);
      const needsAuth = msg.includes('auth-required') || msg.includes('token-expired');
      // errorCode를 120자로 자르는 이유는 트리 행 description에 들어가는 값이라서다.
      store.recordServerScanStatus(
        spec.name, needsAuth ? 'auth-required' : 'failed', observedAt,
        needsAuth ? undefined : msg.slice(0, 120));
      if (needsAuth) authFailed.push(spec);
    }
  }
  store.save();
  onDone(); // refresh() — 상태바·사이드바 ?tok 갱신
  const failNote = failed.length ? ` (failed: ${failed.join(', ')})` : '';
  vscode.window.setStatusBarMessage(
    `$(check) Lens: scanned ${targets.length - failed.length} servers, ${tools} tools, ${tokens}tok${failNote}`, 8000);
  if (authFailed.length) await maybeAuthPrompt(store, authFailed, onDone);
}

/**
 * 사용자가 명시적으로 요청한 스캔. autoScan 설정이 'never'여도 실행한다 —
 * 설정은 '자동으로 하지 말라'는 뜻이지 '눌러도 하지 말라'가 아니다.
 */
export async function scanNow(store: LensStore, onDone: () => void): Promise<void> {
  const { specs, attribution, replaceable, identities } = collectAllSpecs();
  store.upsertClientServers(attribution, replaceable);
  const config = vscode.workspace.getConfiguration('mcpLens');
  const skip = new Set(unsupportedServers(config));
  const targets = specs.filter((s) => !skip.has(s.name));
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('MCP Lens: no MCP servers to scan.');
    return;
  }
  await runScan(store, targets, onDone, identities);
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
    `${action.targets.length} MCP server(s) (${names}) need sign-in. ` +
    `Sign in from your browser? (Lens will request access on your behalf.)`,
    'Sign in', 'Later', "Don't ask for this server");

  if (pick === 'Sign in') {
    const errors: string[] = [];
    const unsupported: string[] = [];
    for (const spec of action.targets) {
      const observedAt = new Date().toISOString();
      try {
        await authenticateServer(spec, {
          openUrl: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
        });
        const result = await scanServer(spec);
        store.upsertScanResult(result.definitions, result.bodies, []);
        // runScan과 같은 분류를 여기서도 적용한다. 안 그러면 로그인에 성공해도
        // Setup Status가 계속 'sign in to scan'을 보여주고, 재시작 후에도 그 상태가 남는다.
        store.recordServerScanStatus(spec.name, 'ok', observedAt);
      } catch (err) {
        // DCR 거부 서버(예: Figma)는 브라우저가 열리기도 전에 실패한다. Lens가 지원할 수 없으므로
        // '지원하지 않는 서버'로 영구 등록해 트리에서 숨기고 다시는 로그인을 묻지 않는다.
        if (isDcrRejected(err)) {
          unsupported.push(spec.name);
        } else {
          errors.push(`${spec.name}: ${friendlyAuthError(err)}`); // 그 외 실패는 원인 표면화
          // runScan과 같은 분류: auth-required/token-expired면 로그인 필요 상태로, 아니면 실패로 기록한다.
          const msg = err instanceof Error ? err.message : String(err);
          const needsAuth = msg.includes('auth-required') || msg.includes('token-expired');
          store.recordServerScanStatus(
            spec.name, needsAuth ? 'auth-required' : 'failed', observedAt,
            needsAuth ? undefined : msg.slice(0, 120));
        }
      }
    }
    store.save();
    if (unsupported.length) {
      const merged = [...new Set([...unsupportedServers(config), ...unsupported])];
      await config.update('unsupportedServers', merged, vscode.ConfigurationTarget.Global);
      void vscode.window.showWarningMessage(
        `MCP Lens does not support the following MCP server(s): ${unsupported.join(', ')}`);
    }
    onDone(); // 트리 새로고침 — unsupported 반영해 숨긴다
    if (errors.length) void vscode.window.showErrorMessage(errors.join('\n'));
  } else if (pick === "Don't ask for this server") {
    const names2 = action.targets.map((t) => t.name);
    await config.update('authIgnore', [...ignoreList, ...names2], vscode.ConfigurationTarget.Global);
  } else if (pick === 'Later') {
    // 이번 VSCode 세션 동안만 억제 — 재시작하면 다시 묻는다.
    for (const t of action.targets) sessionAuthSnooze.add(t.name);
  } // 닫기(undefined) → 아무것도 저장 안 함 → 다음 스캔 때 다시 묻는다
}

export async function maybeAutoScan(store: LensStore, onDone: () => void): Promise<void> {
  const { specs, attribution, replaceable, identities } = collectAllSpecs();
  // 귀속은 설정 파일만 읽으면 되므로 서버 스캔 성공 여부와 무관하게 저장한다.
  // 자동 스캔을 건너뛰는 경우(action.kind === 'skip')에도 매핑은 최신이어야 한다.
  store.upsertClientServers(attribution, replaceable);
  store.save(); // run()은 자동 저장하지 않는다 — 여기서 저장 안 하면 skip 경로(정상 정착 상태의 기본값)에서
                // 매핑이 디스크에 반영되지 않고 다음 활성화 때 다시 빈 매핑으로 보인다.
  const config = vscode.workspace.getConfiguration('mcpLens');
  const setting = config.get<AutoScanSetting>('autoScan', 'prompt');
  const scannedServers = store.serversWithDefinitionBodies();
  const action = decideScanAction({
    setting, specs, scannedServers, unsupported: new Set(unsupportedServers(config)) });

  if (action.kind === 'skip') return;
  if (action.kind === 'scan') return runScan(store, action.targets, onDone, identities);

  // kind === 'prompt' — 합의된 동의창
  const names = action.targets.map((t) => t.name).join(', ');
  const pick = await vscode.window.showInformationMessage(
    `MCP Lens: scan ${action.targets.length} MCP server(s) (${names}) for tool definitions? ` +
    `This briefly runs the server. No LLM tokens are spent and no config file is modified.`,
    'Scan', 'Later', "Don't ask again");
  if (pick === 'Scan') {
    await config.update('autoScan', 'always', vscode.ConfigurationTarget.Global);
    await runScan(store, action.targets, onDone, identities);
  } else if (pick === "Don't ask again") {
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
