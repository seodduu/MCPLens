import * as vscode from 'vscode';
import {
  formatCollectionHealth,
  type CollectionHealthPresentation,
  type CollectionHealthSnapshot,
} from './hookStatus.js';

const ICON: Record<CollectionHealthPresentation['severity'], string> = {
  ok: 'pass', info: 'clock', warning: 'warning', error: 'error', idle: 'circle-outline',
};

export class HookStatusProvider implements vscode.TreeDataProvider<void> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private presentation: CollectionHealthPresentation = formatCollectionHealth({
    health: 'idle', hookObserved: false, logObserved: false,
    consecutiveMisses: 0, consecutiveMatches: 0, waitingForCorrelation: 0, lastEventAt: null,
  });

  setSnapshot(snapshot: CollectionHealthSnapshot, hooksConfigured: boolean): void {
    this.presentation = formatCollectionHealth(snapshot, { hooksConfigured });
    this.emitter.fire();
  }

  current(): CollectionHealthPresentation { return this.presentation; }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(`수집 상태: ${this.presentation.label}`);
    item.description = this.presentation.description;
    item.tooltip = this.presentation.tooltip;
    item.iconPath = new vscode.ThemeIcon(ICON[this.presentation.severity]);
    if (this.presentation.severity === 'warning' || this.presentation.severity === 'error') {
      item.command = { command: 'mcp-lens.hooksDoctor', title: 'MCP Lens: Hook 진단' };
    }
    return item;
  }

  getChildren(): void[] { return []; }
}
