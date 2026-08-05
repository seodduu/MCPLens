// packages/extension/src/lensTreeProvider.ts
import * as vscode from 'vscode';
import type { LensNode } from './matrixTree.js';

const ACTION_ICON: Record<string, string> = {
  inspect: 'warning', remove: 'trash', 'filter-server': 'filter', keep: 'check',
};

/** Icon accent colour: keep (check) blue, inspect (danger) red. Everything else uses the default. */
const ACTION_COLOR: Record<string, string> = {
  keep: 'charts.blue', inspect: 'charts.red',
};

function actionIcon(action: string): vscode.ThemeIcon {
  const color = ACTION_COLOR[action];
  return new vscode.ThemeIcon(
    ACTION_ICON[action] ?? 'circle-outline',
    color ? new vscode.ThemeColor(color) : undefined);
}

export class LensTreeProvider implements vscode.TreeDataProvider<LensNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: LensNode[] = [];

  setRoots(roots: LensNode[]): void { this.roots = roots; this.emitter.fire(); }

  getTreeItem(n: LensNode): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label,
      n.children.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    item.description = n.description;
    // No hover description: wording diverged per tool and client and only cost reading effort.
    // Hover behaviour is unified into the single disable action on removable tools.
    if (n.kind === 'tool' && n.analysisStatus) {
      item.command = {
        command: 'mcplens.openAnalysisDetails',
        title: 'Open analysis details',
        arguments: [n],
      };
    }
    if (n.kind === 'hint') {
      // Pre-scan guidance. The row itself is the button: clicking it runs a scan immediately.
      item.iconPath = new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('list.warningForeground'));
      item.command = { command: 'mcp-lens.scanNow', title: 'Scan MCP servers' };
      return item;
    }
    if (n.kind === 'client') item.iconPath = new vscode.ThemeIcon('device-desktop');
    else if (n.kind === 'server') {
      item.iconPath = new vscode.ThemeIcon(n.enabled === false ? 'close' : 'server');
      if (n.enabled === true) item.contextValue = 'mcpServer-enabled';
      else if (n.enabled === false) item.contextValue = 'mcpServer-disabled';
    }
    else if (n.enabled === false) {
      item.iconPath = new vscode.ThemeIcon('close');
      item.contextValue = 'mcpTool-disabled';
    } else if (n.searchedNotCalled) {
      // Loaded but never called: the nuance is "found by search, never invoked".
      // This fact is always shown, even when low confidence suppresses the recommendation icon.
      item.iconPath = new vscode.ThemeIcon('search', new vscode.ThemeColor('list.warningForeground'));
      if (n.enabled === true) item.contextValue = 'mcpTool-enabled';
    } else {
      // Low-confidence recommendations get no icon emphasis (a candidate, not a verdict)
      if (n.action && n.confidence !== 'low')
        item.iconPath = actionIcon(n.action);
      if (n.enabled === true) item.contextValue = 'mcpTool-enabled';
    }
    if (n.kind === 'tool' && n.canDisableGlobally) item.contextValue = 'mcpAnalysis-disable';
    else if (n.kind === 'tool' && n.canRestoreGlobally) item.contextValue = 'mcpAnalysis-restore';
    return item;
  }
  getChildren(n?: LensNode): LensNode[] { return n ? n.children : this.roots; }
}
