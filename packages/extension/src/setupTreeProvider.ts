import * as vscode from 'vscode';
import type { SetupGroup, SetupIcon, SetupRow } from './setupTree.js';

/** 트리 렌더링 순서 고정 — buildSetupRows 출력과 무관하게 항상 이 순서로 그룹을 보여준다. */
const GROUPS: SetupGroup[] = ['MCP authentication', 'Dependency analysis', 'Global actions'];

const ICON: Record<SetupIcon, string> = {
  pass: 'pass', warning: 'warning', 'circle-outline': 'circle-outline', error: 'error',
  'circle-slash': 'circle-slash', account: 'account', lock: 'lock', unlock: 'unlock',
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
    item.iconPath = new vscode.ThemeIcon(ICON[row.icon]);
    if (row.command) {
      // reanalyzeServer는 { serverName } 모양의 LensNode를 기대한다(analysisTree.ts 관례).
      // authenticateServer도 같은 모양을 받아 서버 이름을 얻는다. scanNow/openRolloutSetting은
      // 인자를 안 받으므로 여분의 인자를 넘겨도 무해하다.
      item.command = { command: row.command, title: row.label, arguments: [{ serverName: row.label }] };
    }
    return item;
  }

  getChildren(node?: SetupNode): SetupNode[] {
    if (!node) return GROUPS.map((group) => ({ kind: 'group', group }));
    if (node.kind === 'row') return [];
    return this.rows.filter((row) => row.group === node.group).map((row) => ({ kind: 'row', row }));
  }
}
