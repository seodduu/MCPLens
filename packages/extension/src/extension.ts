import * as vscode from 'vscode';
import * as path from 'node:path';
import { LensStore, LogWatcher, buildMatrix, splitByClient, visibleMatrixRows, sessionSavings, dbPath,
  detectClients, ClaudeAdapter, CodexAdapter, GeminiAdapter,
  claudeSettingsPath, readDeniedMcpTools, denyMcpTool, allowMcpTool } from '@mcp-lens/core';
import { formatStatus } from './statusBar.js';
import { buildTree } from './matrixTree.js';
import type { LensNode } from './matrixTree.js';
import { LensTreeProvider } from './lensTreeProvider.js';
import { maybeAutoScan, watchConfigSources } from './autoScan.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Lens: starting…'; item.command = 'mcp-lens.showReport'; item.show();
  ctx.subscriptions.push(item);

  const treeProvider = new LensTreeProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.matrix', treeProvider));

  store = await LensStore.open(dbPath()); // 전역 제약 2: 공유 경로
  const active = detectClients().filter((c) => c.installed);
  watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]
      .filter((a) => active.some((c) => c.client === a.client)));

  const reportDays = () =>
    Math.max(1, vscode.workspace.getConfiguration('mcpLens').get<number>('reportDays', 30));
  const sinceIso = () => new Date(Date.now() - reportDays() * 86_400_000).toISOString();

  const readDeniedSafe = (): Set<string> => {
    try { return readDeniedMcpTools(claudeSettingsPath()); }
    catch { return new Set(); } // 깨진 settings.json — 표시는 계속, 쓰기 시점에 에러 안내
  };
  const refresh = () => {
    const since = sinceIso();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
    item.text = formatStatus(input.calls.length, sessionSavings(input).savedTokens);
    treeProvider.setRoots(buildTree(input, readDeniedSafe()));
  };
  await watcher.backfill(); // 시작 시 밀린 세션 따라잡기 (기능 2)
  refresh();
  watcher.on('ingested', refresh);
  watcher.start();
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
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
      const sections = splitByClient(input).map(({ client, input: sub }) => {
        const all = buildMatrix(sub);
        const rows = visibleMatrixRows(all, sub.sessions);
        const hidden = all.length - rows.length;
        const lines = rows.map((r) =>
          `- ${r.serverName}/${r.toolName}: ${r.callCount}회, 응답 ${r.responseTokens}tok, 정의 ${r.definitionTokens ?? '?'}tok → ${r.recommendation.action} (${r.recommendation.reason})`);
        const hiddenNote = hidden > 0
          ? `\n- _(지연 로딩 — 로드·호출 0회라 실비용 없는 툴 ${hidden}개 표시 생략)_` : '';
        return `## ${client} (세션 ${sub.sessions.length}개)\n${lines.length ? lines.join('\n') : '- MCP 호출 없음'}${hiddenNote}`;
      });
      const doc = `# MCP Lens Report (최근 ${reportDays()}일)\n\n${sections.join('\n\n')}`;
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }));
}

export async function deactivate() { await watcher?.stop(); store?.save(); store?.close(); }
