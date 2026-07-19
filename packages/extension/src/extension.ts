import * as vscode from 'vscode';
import { LensStore, LogWatcher, buildMatrix, splitByClient, sessionSavings, dbPath,
  detectClients, ClaudeAdapter, CodexAdapter, GeminiAdapter } from '@mcp-lens/core';
import { formatStatus } from './statusBar.js';
import { buildTree } from './matrixTree.js';
import { LensTreeProvider } from './lensTreeProvider.js';

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

  const refresh = () => {
    const since = sinceIso();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
    item.text = formatStatus(input.calls.length, sessionSavings(input).savedTokens);
    treeProvider.setRoots(buildTree(input));
  };
  await watcher.backfill(); // 시작 시 밀린 세션 따라잡기 (기능 2)
  refresh();
  watcher.on('ingested', refresh);
  watcher.start();
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mcpLens.reportDays')) refresh();
  }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.showReport', () => {
      const since = sinceIso();
      const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
      const sections = splitByClient(input).map(({ client, input: sub }) => {
        const rows = buildMatrix(sub).filter((r) => r.callCount > 0 || r.definitionTokens != null);
        const lines = rows.map((r) =>
          `- ${r.serverName}/${r.toolName}: ${r.callCount}회, 응답 ${r.responseTokens}tok, 정의 ${r.definitionTokens ?? '?'}tok → ${r.recommendation.action} (${r.recommendation.reason})`);
        return `## ${client} (세션 ${sub.sessions.length}개)\n${lines.length ? lines.join('\n') : '- MCP 호출 없음'}`;
      });
      const doc = `# MCP Lens Report (최근 ${reportDays()}일)\n\n${sections.join('\n\n')}`;
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }));
}

export async function deactivate() { await watcher?.stop(); store?.save(); store?.close(); }
