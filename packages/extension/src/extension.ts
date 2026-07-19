import * as vscode from 'vscode';
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath, detectClients,
  ClaudeAdapter, CodexAdapter, GeminiAdapter } from '@mcp-lens/core';
import { formatStatus } from './statusBar.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Lens: starting…'; item.command = 'mcp-lens.showReport'; item.show();
  ctx.subscriptions.push(item);

  store = await LensStore.open(dbPath()); // 전역 제약 2: 공유 경로
  const active = detectClients().filter((c) => c.installed);
  watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]
      .filter((a) => active.some((c) => c.client === a.client)));

  const refresh = () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
    item.text = formatStatus(input.calls.length, sessionSavings(input).savedTokens);
  };
  await watcher.backfill(); // 시작 시 밀린 세션 따라잡기 (기능 2)
  refresh();
  watcher.on('ingested', refresh);
  watcher.start();

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.showReport', () => {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
      const rows = buildMatrix(input);
      const doc = rows.map((r) =>
        `${r.serverName}/${r.toolName}: ${r.callCount}회, 응답 ${r.responseTokens}tok, 정의 ${r.definitionTokens ?? '?'}tok → ${r.recommendation.action} (${r.recommendation.reason})`).join('\n');
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }));
}

export async function deactivate() { await watcher?.stop(); store?.save(); store?.close(); }
