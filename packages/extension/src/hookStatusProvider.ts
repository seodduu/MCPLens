import * as vscode from 'vscode';
import { clientRowPresentation, type CollectionHealthPresentation, type CollectionHealthSnapshot } from './hookStatus.js';
import type { HookClient, InstallState } from './hookInstall.js';

const ICON: Record<CollectionHealthPresentation['severity'], string> = {
  ok: 'pass', info: 'clock', warning: 'warning', error: 'error', idle: 'circle-outline',
};

/** 수집상태 색: hook 살아있으면 파랑, 로그만이면 주황, 모두 없으면 빨강. */
function collectionColor(snapshot?: CollectionHealthSnapshot): string {
  if (snapshot?.hookObserved) return 'charts.blue';
  if (snapshot?.logObserved) return 'charts.orange';
  return 'charts.red';
}

export interface ClientRowInput {
  client: HookClient;
  install: InstallState;
  snapshot?: CollectionHealthSnapshot;
}

export interface ClientRow {
  client: HookClient;
  label: string;
  description: string;
  tooltip: string;
  severity: CollectionHealthPresentation['severity'];
  /** 아이콘 강조색 — hook 파랑 / 로그만 주황 / 없음 빨강 */
  colorId: string;
  contextValue: 'hook-installable' | 'hook-installed';
}

export function toRow(input: ClientRowInput): ClientRow {
  const p = clientRowPresentation(input.install, input.snapshot);
  return {
    client: input.client,
    label: `${input.client}: ${p.label}`,
    description: p.description,
    tooltip: p.tooltip,
    severity: p.severity,
    colorId: collectionColor(input.snapshot),
    contextValue: input.install === 'not-installed' ? 'hook-installable' : 'hook-installed',
  };
}

export class HookStatusProvider implements vscode.TreeDataProvider<ClientRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: ClientRow[] = [];

  setClients(inputs: ClientRowInput[]): void {
    this.rows = inputs.filter((i) => i.install !== 'client-missing').map(toRow);
    this.emitter.fire();
  }

  getTreeItem(row: ClientRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.id = row.client;
    item.contextValue = row.contextValue;
    item.iconPath = new vscode.ThemeIcon(ICON[row.severity], new vscode.ThemeColor(row.colorId));
    if (row.severity === 'warning' || row.severity === 'error') {
      item.command = { command: 'mcp-lens.hooksDoctor', title: 'MCP Lens: Hook 진단', arguments: [row.client] };
    }
    return item;
  }

  getChildren(element?: ClientRow): ClientRow[] {
    return element ? [] : this.rows;
  }
}
