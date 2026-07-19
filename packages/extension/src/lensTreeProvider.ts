// packages/extension/src/lensTreeProvider.ts
import * as vscode from 'vscode';
import type { LensNode } from './matrixTree.js';

const ACTION_ICON: Record<string, string> = {
  inspect: 'warning', remove: 'trash', 'filter-server': 'filter', keep: 'check',
};

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
    item.tooltip = n.tooltip;
    if (n.kind === 'client') item.iconPath = new vscode.ThemeIcon('device-desktop');
    else if (n.kind === 'server') item.iconPath = new vscode.ThemeIcon('server');
    else if (n.enabled === false) {
      item.iconPath = new vscode.ThemeIcon('close');
      item.contextValue = 'mcpTool-disabled';
    } else {
      if (n.action) item.iconPath = new vscode.ThemeIcon(ACTION_ICON[n.action] ?? 'circle-outline');
      if (n.enabled === true) item.contextValue = 'mcpTool-enabled';
    }
    return item;
  }
  getChildren(n?: LensNode): LensNode[] { return n ? n.children : this.roots; }
}
