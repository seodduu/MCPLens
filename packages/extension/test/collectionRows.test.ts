import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Minimal vscode stub so the provider can be constructed and its tree items built.
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => () => {}; fire() {} },
  TreeItem: class {
    description = '';
    tooltip: string | undefined;
    iconPath: unknown;
    command: unknown;
    id: string | undefined;
    contextValue: string | undefined;
    constructor(public label: string, public collapsibleState?: unknown) {}
  },
  TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1, None: 0 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
}));

import { collectionRows, toRow } from '../src/collectionRows.js';
import { SetupStatusProvider } from '../src/setupTreeProvider.js';

const healthy = {
  health: 'healthy' as const, hookObserved: true, logObserved: true,
  consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null };

describe('toRow', () => {
  it('marks a client that is not installed as installable and disconnected', () => {
    const r = toRow({ client: 'codex', install: 'not-installed', snapshot: undefined });
    expect(r.contextValue).toBe('hook-installable');
    expect(r.description).toContain('Install needed');
    expect(r.client).toBe('codex');
  });
  it('marks an installed client as installed', () => {
    const r = toRow({ client: 'claude-code', install: 'installed', snapshot: healthy });
    expect(r.contextValue).toBe('hook-installed');
    expect(r.label).toContain('claude-code');
  });
});

describe('collectionRows', () => {
  it('emits one row per client, excluding client-missing', () => {
    const rows = collectionRows([
      { client: 'claude-code', install: 'installed', snapshot: undefined },
      { client: 'codex', install: 'not-installed', snapshot: undefined },
      { client: 'gemini-cli', install: 'client-missing', snapshot: undefined },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['claude-code', 'codex']);
  });

  it('puts every row in the Collection group of Setup Status', () => {
    const rows = collectionRows([{ client: 'codex', install: 'not-installed', snapshot: undefined }]);
    expect(rows.every((r) => r.group === 'Collection')).toBe(true);
  });

  it('picks the colour from hook/log observation: hook blue, logs only orange, neither red', () => {
    const snap = (hookObserved: boolean, logObserved: boolean) => ({
      ...healthy, hookObserved, logObserved });
    const rows = collectionRows([
      { client: 'claude-code', install: 'installed', snapshot: snap(true, true) },
      { client: 'codex', install: 'installed', snapshot: snap(false, true) },
      { client: 'gemini-cli', install: 'installed', snapshot: snap(false, false) },
    ]);
    expect(rows.map((r) => r.colorId))
      .toEqual(['charts.blue', 'charts.orange', 'charts.red']);
  });

  it('attaches the hooksDoctor command to warning and error rows only', () => {
    const [warn] = collectionRows([{ client: 'codex', install: 'not-installed', snapshot: undefined }]);
    expect(warn.command).toBe('mcp-lens.hooksDoctor');
    expect(warn.commandArgs).toEqual(['codex']);
  });

  it('attaches no command to healthy rows: there is nothing to fix on them', () => {
    const [ok] = collectionRows([{ client: 'claude-code', install: 'installed', snapshot: healthy }]);
    expect(ok.command).toBeUndefined();
  });
});

describe('rendering the Collection group of the Setup Status view', () => {
  const provider = () => {
    const p = new SetupStatusProvider();
    p.setRows(collectionRows([
      { client: 'codex', install: 'not-installed', snapshot: undefined },
      { client: 'claude-code', install: 'installed', snapshot: healthy },
    ]));
    return p;
  };
  const rowsOf = (p: SetupStatusProvider) => p.getChildren(p.getChildren()[0]);

  it('puts Collection first: without collection the other numbers cannot be trusted', () => {
    const [first] = provider().getChildren();
    expect(first.kind === 'group' && first.group).toBe('Collection');
  });

  it('fills id, contextValue, description, icon and colour on the row', () => {
    const p = provider();
    const item = p.getTreeItem(rowsOf(p)[0]) as unknown as {
      id?: string; contextValue?: string; description: string;
      iconPath: { id: string; color?: { id: string } };
    };
    expect(item.id).toBe('codex');
    expect(item.contextValue).toBe('hook-installable');
    expect(item.description).toContain('Install needed');
    expect(item.iconPath.id).toBe('warning');
    expect(item.iconPath.color?.id).toBe('charts.red');
  });

  it('gives hooksDoctor the client name rather than a server name object', () => {
    const p = provider();
    const item = p.getTreeItem(rowsOf(p)[0]);
    expect(item.command?.command).toBe('mcp-lens.hooksDoctor');
    expect(item.command?.arguments).toEqual(['codex']);
  });

  it('attaches the uninstall-menu contextValue to installed clients', () => {
    const p = provider();
    expect(p.getTreeItem(rowsOf(p)[1]).contextValue).toBe('hook-installed');
  });
});

describe('hook menu routing manifest', () => {
  it('points the install and uninstall menus at the Setup Status view', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const hookItems = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('hook-install'));
    expect(hookItems).toHaveLength(2);
    for (const item of hookItems) expect(item.when).toContain('view == mcpLens.setupStatus');
    // The old view is gone from the manifest: leaving it would recreate the empty section.
    expect(manifest.contributes.views.mcpLens.map((v: { id: string }) => v.id))
      .not.toContain('mcpLens.collection');
  });
});
