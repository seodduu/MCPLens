import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class { event = () => () => {}; fire() {} },
  TreeItem: class {
    description = '';
    tooltip = '';
    iconPath: unknown;
    command: unknown;
    id: string | undefined;
    contextValue: string | undefined;
    constructor(public label: string) {}
  },
  TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
  ThemeIcon: class { constructor(..._args: unknown[]) {} },
  ThemeColor: class { constructor(..._args: unknown[]) {} },
}));

import { LensTreeProvider } from '../src/lensTreeProvider.js';

const tool = (overrides: Record<string, unknown> = {}) => ({
  kind: 'tool' as const, id: 'claude-code/docs/search', label: 'search', description: '', children: [],
  ...overrides,
});

describe('LensTreeProvider global action contexts', () => {
  it('assigns only the disable context to an eligible inactive tool', () => {
    const item = new LensTreeProvider().getTreeItem(tool({ canDisableGlobally: true }) as any);
    expect(item.contextValue).toBe('mcpAnalysis-disable');
  });

  it('assigns only the restore context to an active Lens-owned action', () => {
    const item = new LensTreeProvider().getTreeItem(tool({ canRestoreGlobally: true }) as any);
    expect(item.contextValue).toBe('mcpAnalysis-restore');
  });

  // Hover descriptions diverged per tool and client. This pins them out so they do not come back.
  it('leaves the hover tooltip unset even when analysis text exists', () => {
    const item = new LensTreeProvider().getTreeItem(tool({
      analysisStatus: 'Independent', analysisSummary: 'safe to remove',
    }) as any);
    expect(item.tooltip).toBeFalsy();
  });

  it('assigns neither action context when no action is available', () => {
    const item = new LensTreeProvider().getTreeItem(tool() as any);
    expect(item.contextValue).toBeUndefined();
  });
});
