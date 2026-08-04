// packages/extension/src/lensTreeProvider.ts
import * as vscode from 'vscode';
import type { LensNode } from './matrixTree.js';

const ACTION_ICON: Record<string, string> = {
  inspect: 'warning', remove: 'trash', 'filter-server': 'filter', keep: 'check',
};

/** 아이콘 강조색 — keep(체크) 파랑, inspect(위험) 빨강. 나머지는 기본색. */
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
    item.tooltip = n.tooltip;
    if (n.kind === 'tool' && n.analysisStatus) {
      item.command = {
        command: 'mcplens.openAnalysisDetails',
        title: 'Open analysis details',
        arguments: [n],
      };
      item.tooltip = n.analysisSummary ?? n.tooltip;
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
      // 로드는 됐으나 호출 0회 — "검색만 되고 호출은 안 됨" 뉘앙스.
      // 확신이 낮아 권고 아이콘은 억제되더라도 이 사실 자체는 항상 표시한다.
      item.iconPath = new vscode.ThemeIcon('search', new vscode.ThemeColor('list.warningForeground'));
      if (n.enabled === true) item.contextValue = 'mcpTool-enabled';
    } else {
      // 확신 낮은 권고는 아이콘으로 강조하지 않는다 (후보일 뿐 확정 아님)
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
