import * as vscode from 'vscode';
import type { SetupGroup, SetupIcon, SetupRow } from './setupTree.js';

/** Fixed tree rendering order: groups always appear in this order regardless of buildSetupRows output. */
const GROUPS: SetupGroup[] =
  ['Collection', 'MCP authentication', 'Dependency analysis', 'Global actions'];

const ICON: Record<SetupIcon, string> = {
  pass: 'pass', warning: 'warning', 'circle-outline': 'circle-outline', error: 'error',
  'circle-slash': 'circle-slash', account: 'account', lock: 'lock', unlock: 'unlock',
  clock: 'clock', 'mortar-board': 'mortar-board',
};

type SetupNode = { kind: 'group'; group: SetupGroup } | { kind: 'row'; row: SetupRow };

export class SetupStatusProvider implements vscode.TreeDataProvider<SetupNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: SetupRow[] = [];

  setRows(rows: SetupRow[]): void {
    this.rows = rows;
    this.emitter.fire();
  }

  getTreeItem(node: SetupNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.group;
      return item;
    }
    const { row } = node;
    const item = new vscode.TreeItem(row.label);
    item.description = row.description;
    item.id = row.id ?? (row.group ? `${row.group}/${row.label}` : row.label);
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    item.iconPath = new vscode.ThemeIcon(
      ICON[row.icon], row.colorId ? new vscode.ThemeColor(row.colorId) : undefined);
    if (row.command) {
      // reanalyzeServer expects a LensNode shaped like { serverName } (the analysisTree.ts convention).
      // authenticateServer takes the same shape to get the server name. scanNow/openRolloutSetting take
      // no arguments, so an extra argument is harmless.
      // Rows that want a different shape, such as collection rows, set commandArgs explicitly.
      item.command = { command: row.command, title: row.label,
        arguments: row.commandArgs ?? [{ serverName: row.label }] };
    }
    return item;
  }

  getChildren(node?: SetupNode): SetupNode[] {
    if (!node) {
      // Rows with no group lead the view, above every group header. Only the Get started row uses this,
      // and it has to be the first thing a first-time user sees.
      const lead: SetupNode[] = this.rows.filter((row) => row.group === undefined)
        .map((row) => ({ kind: 'row', row }));
      return [...lead, ...GROUPS.map((group): SetupNode => ({ kind: 'group', group }))];
    }
    if (node.kind === 'row') return [];
    return this.rows.filter((row) => row.group === node.group).map((row) => ({ kind: 'row', row }));
  }
}
