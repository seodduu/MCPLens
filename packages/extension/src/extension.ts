import * as vscode from 'vscode';
import * as path from 'node:path';
import { LensStore, LogWatcher, dbPath,
  detectClients, ClaudeAdapter, CodexAdapter, GeminiAdapter,
  claudeSettingsPath, readDeniedMcpTools, denyMcpTool, allowMcpTool,
  defaultClaudeConfigPaths, listManagedServers, disableServer, enableServer, type ManagedServer,
  buildReport, renderReport } from '@mcp-lens/core';
import { formatStatus, wasteTooltip } from './statusBar.js';
import { buildTree } from './matrixTree.js';
import type { LensNode } from './matrixTree.js';
import { LensTreeProvider } from './lensTreeProvider.js';
import { maybeAutoScan, watchConfigSources } from './autoScan.js';
import { reportOptions } from './reportCommand.js';
import { HookStatusProvider } from './hookStatusProvider.js';
import type { CollectionHealthSnapshot } from './hookStatus.js';
import { detectClaudeHookInstall, installClaudeHooks, uninstallClaudeHooks, type HookInstallDeps } from './hookInstall.js';
import { findClaudeBinary, runClaude, nodeFs } from './claudeCli.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;

type IngestionCoordinatorLike = {
  drainInbox(): Promise<unknown>;
  on(event: 'ingested' | 'receipt', listener: () => void): unknown;
  pause?: () => void | Promise<void>;
};

type HealthStore = LensStore & { collectionHealth?: () => CollectionHealthSnapshot };

function coordinatorFor(store: LensStore): IngestionCoordinatorLike | undefined {
  const Constructor = (require('@mcp-lens/core') as {
    IngestionCoordinator?: new (options: { store: LensStore }) => IngestionCoordinatorLike;
  }).IngestionCoordinator;
  return Constructor ? new Constructor({ store }) : undefined;
}

function healthFor(store: LensStore): CollectionHealthSnapshot {
  return (store as HealthStore).collectionHealth?.() ?? {
    health: 'idle', hookObserved: false, logObserved: false,
    consecutiveMisses: 0, consecutiveMatches: 0, waitingForCorrelation: 0, lastEventAt: null,
  };
}

export async function activate(ctx: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Lens: starting…'; item.command = 'mcp-lens.showReport'; item.show();
  ctx.subscriptions.push(item);

  const treeProvider = new LensTreeProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.matrix', treeProvider));
  const hookStatusProvider = new HookStatusProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.collection', hookStatusProvider));

  const DISMISS_KEY = 'mcpLens.hookInstall.dismissed';
  function hookDeps(): HookInstallDeps {
    const bin = findClaudeBinary();
    return {
      home: require('node:os').homedir(),
      findClaudeBinary,
      runClaude: (args) => runClaude(bin ?? 'claude', args),
      fs: nodeFs,
      bundledMarketplaceDir: path.join(__dirname, 'claude-marketplace'),
    };
  }
  async function runInstallFlow() {
    const result = await installClaudeHooks(hookDeps());
    if (result.kind === 'claude-missing') {
      void vscode.window.showWarningMessage('MCP Lens: claude CLI를 찾을 수 없어 훅을 설치할 수 없습니다. Claude Code 설치를 확인하세요.');
    } else if (result.kind === 'failed') {
      void vscode.window.showErrorMessage(`MCP Lens 훅 설치 실패 (${result.step}): ${result.stderr.slice(0, 300)}`);
    } else if (result.alreadyInstalled) {
      void vscode.window.showInformationMessage('MCP Lens: Claude 훅이 이미 설치되어 있습니다.');
    } else {
      void vscode.window.showInformationMessage('MCP Lens: 훅 설치 완료 — 새 Claude 세션을 시작하면 수집이 시작됩니다.');
    }
  }
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.installClaudeHooks', () => runInstallFlow()),
    vscode.commands.registerCommand('mcp-lens.uninstallClaudeHooks', async () => {
      const result = await uninstallClaudeHooks(hookDeps());
      if (result.kind === 'ok') void vscode.window.showInformationMessage('MCP Lens: Claude 훅을 제거했습니다.');
      else if (result.kind === 'claude-missing') void vscode.window.showWarningMessage('MCP Lens: claude CLI를 찾을 수 없습니다.');
      else void vscode.window.showErrorMessage(`MCP Lens 훅 제거 실패: ${result.stderr.slice(0, 300)}`);
    }));

  store = await LensStore.open(dbPath()); // 전역 제약 2: 공유 경로
  const coordinator = coordinatorFor(store);
  const active = detectClients().filter((c) => c.installed);
  watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]
      .filter((a) => active.some((c) => c.client === a.client)),
    { onReceipt: () => refresh() });

  const reportDays = () =>
    Math.max(1, vscode.workspace.getConfiguration('mcpLens').get<number>('reportDays', 30));
  const sinceIso = () => new Date(Date.now() - reportDays() * 86_400_000).toISOString();

  const readDeniedSafe = (): Set<string> => {
    try { return readDeniedMcpTools(claudeSettingsPath()); }
    catch { return new Set(); } // 깨진 settings.json — 표시는 계속, 쓰기 시점에 에러 안내
  };
  // 표 전체가 비어 있으면(스캔 전) undefined를 넘겨 필터링을 끈다.
  // 표에 행이 있는데 특정 클라이언트 키만 없는 경우(예: gemini-cli 서버 0개)는
  // 그대로 넘겨 splitByClient가 그 클라이언트를 정의 0개로 걸러내게 한다.
  const serversByClientOrUndefined = () => {
    const m = store!.serversByClient();
    return m.size > 0 ? m : undefined;
  };
  const configPaths = defaultClaudeConfigPaths();
  const listManagedSafe = (): ManagedServer[] => {
    try { return listManagedServers(configPaths); }
    catch { return []; } // 수집 실패 — 표시는 계속
  };
  const refresh = () => {
    const since = sinceIso();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since),
      lastCallByTool: store!.lastCallByTool(),
      serversByClient: serversByClientOrUndefined() };
    // totals는 detail(툴 목록 절단)에 영향받지 않으므로 최소 opts로 충분.
    const totals = buildReport(input, { days: reportDays(), detail: 'summary' }).totals;
    const wasteToolCount = totals.actToolCount + totals.candidateToolCount;
    const wasteTokens = totals.actPerSessionTokens + totals.candidatePerSessionTokens;
    item.text = formatStatus(wasteToolCount, wasteTokens);
    item.tooltip = wasteTooltip(wasteToolCount, wasteTokens);
    treeProvider.setRoots(buildTree(input, readDeniedSafe(), listManagedSafe()));
    hookStatusProvider.setSnapshot(healthFor(store!), active.length > 0);
  };
  await coordinator?.drainInbox();
  await watcher.backfill(); // 시작 시 밀린 세션 따라잡기 (기능 2)
  refresh();
  coordinator?.on('ingested', refresh);
  coordinator?.on('receipt', refresh);
  watcher.on('ingested', refresh);
  watcher.start();

  void (async () => {
    if (ctx.globalState.get<boolean>(DISMISS_KEY)) return;
    if (!detectClients().some((c) => c.client === 'claude-code' && c.installed)) return;
    if (await detectClaudeHookInstall(hookDeps()) !== 'not-installed') return;
    const choice = await vscode.window.showInformationMessage(
      'MCP Lens: Claude Code 훅 수집을 켜시겠어요? (설정 편집 없이 설치됩니다)',
      '설치', '나중에', '다시 안 보기');
    if (choice === '설치') await runInstallFlow();
    else if (choice === '다시 안 보기') await ctx.globalState.update(DISMISS_KEY, true);
  })();

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mcpLens.reportDays')) refresh();
  }));

  void maybeAutoScan(store, refresh);                     // 시작 시 1회 판정
  ctx.subscriptions.push(watchConfigSources(store, refresh)); // 이후 설정 파일 감시

  // deny 토글: settings.json이 원본 — 커맨드는 파일만 수정, 워처가 트리에 반영
  const toggleTool = (node: LensNode, action: 'deny' | 'allow') => {
    if (!node?.serverName || !node.toolName) return;
    try {
      if (action === 'deny') {
        denyMcpTool(claudeSettingsPath(), node.serverName, node.toolName);
        void vscode.window.showInformationMessage(
          `${node.serverName}/${node.toolName} 차단됨 — 새 Claude Code 세션부터 적용됩니다.`);
      } else {
        allowMcpTool(claudeSettingsPath(), node.serverName, node.toolName);
        void vscode.window.showInformationMessage(
          `${node.serverName}/${node.toolName} 차단 해제됨 — 새 Claude Code 세션부터 적용됩니다.`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        `settings.json을 수정하지 못했습니다 (파일은 변경되지 않음): ${e instanceof Error ? e.message : String(e)}`);
    }
    refresh();
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.removeTool', (n: LensNode) => toggleTool(n, 'deny')),
    vscode.commands.registerCommand('mcp-lens.addTool', (n: LensNode) => toggleTool(n, 'allow')));

  // 서버 단위 토글: 설정 파일들이 원본 — 커맨드는 파일만 수정, 워처가 트리에 반영
  const toggleServer = async (node: LensNode, action: 'disable' | 'enable') => {
    if (node?.kind !== 'server' || !node.serverName) return;
    try {
      if (action === 'disable') {
        const pick = await vscode.window.showWarningMessage(
          `${node.serverName} 서버를 Claude Code에서 차단할까요? 서버 연결과 툴 정의 로드가 모두 중단됩니다.`,
          { modal: true }, '차단');
        if (pick !== '차단') return;
        disableServer(configPaths, node.serverName);
        void vscode.window.showInformationMessage(
          `${node.serverName} 서버 차단됨 — 새 Claude Code 세션부터 적용됩니다.`);
      } else {
        enableServer(configPaths, node.serverName);
        void vscode.window.showInformationMessage(
          `${node.serverName} 서버 차단 해제됨 — 새 Claude Code 세션부터 적용됩니다.`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        `서버 설정을 수정하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    refresh();
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.removeServer', (n: LensNode) => toggleServer(n, 'disable')),
    vscode.commands.registerCommand('mcp-lens.addServer', (n: LensNode) => toggleServer(n, 'enable')));

  const watchFile = (absPath: string) => {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(absPath)), path.basename(absPath)));
    w.onDidChange(refresh); w.onDidCreate(refresh); w.onDidDelete(refresh);
    ctx.subscriptions.push(w);
  };
  watchFile(configPaths.claudeJsonPath); // ~/.claude.json
  watchFile(configPaths.stashPath);      // ~/.mcplens/disabled-servers.json

  const settingsDir = vscode.Uri.file(path.dirname(claudeSettingsPath()));
  const settingsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(settingsDir, 'settings.json'));
  settingsWatcher.onDidChange(refresh);
  settingsWatcher.onDidCreate(refresh);
  settingsWatcher.onDidDelete(refresh);
  ctx.subscriptions.push(settingsWatcher);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.showReport', () => {
      const since = sinceIso();
      const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since),
        lastCallByTool: store!.lastCallByTool(),
        serversByClient: serversByClientOrUndefined() };
      const opts = reportOptions({
        reportDays: vscode.workspace.getConfiguration('mcpLens').get<number>('reportDays', 30),
        reportDetail: vscode.workspace.getConfiguration('mcpLens').get<'summary' | 'full'>('reportDetail'),
      });
      const doc = renderReport(buildReport(input, opts), opts);
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }),
    vscode.commands.registerCommand('mcp-lens.hooksDoctor', () => {
      const status = hookStatusProvider.current();
      void vscode.window.showInformationMessage(`MCP Lens 수집 상태: ${status.label} — ${status.description}`);
    }),
    vscode.commands.registerCommand('mcp-lens.hooksPause', async () => {
      if (coordinator?.pause) {
        await coordinator.pause();
        void vscode.window.showInformationMessage('MCP Lens Hook 수집을 일시 중지했습니다.');
      } else {
        void vscode.window.showWarningMessage(
          '이 버전에서는 Hook 수집을 확장에서 일시 중지할 수 없습니다. 클라이언트의 Hook 또는 플러그인을 비활성화하세요.');
      }
    }));
}

export async function deactivate() { await watcher?.stop(); store?.save(); store?.close(); }
