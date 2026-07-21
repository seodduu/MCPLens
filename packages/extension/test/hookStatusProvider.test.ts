import { describe, expect, it, vi } from 'vitest';

// Minimal vscode stub so the provider can be constructed and its tree items built.
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => () => {}; fire() {} },
  TreeItem: class {
    description = '';
    tooltip = '';
    iconPath: unknown;
    command: unknown;
    constructor(public label: string) {}
  },
  ThemeIcon: class { constructor(public id: string) {} },
}));

import { HookStatusProvider } from '../src/hookStatusProvider.js';

describe('HookStatusProvider', () => {
  it('renders exactly one root row so the view is not empty', () => {
    const provider = new HookStatusProvider();
    const roots = provider.getChildren();
    expect(roots).toHaveLength(1);
    // the row itself is a leaf
    expect(provider.getChildren(roots[0])).toHaveLength(0);
  });

  it('labels the row with the current collection health', () => {
    const item = new HookStatusProvider().getTreeItem() as { label: string };
    expect(item.label).toContain('수집 상태');
  });

  it('updates the row label when a snapshot arrives', () => {
    const provider = new HookStatusProvider();
    provider.setSnapshot({
      health: 'healthy', hookObserved: true, logObserved: true,
      consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null,
    }, true);
    const item = provider.getTreeItem() as { label: string };
    expect(item.label).toContain('정상');
  });
});
