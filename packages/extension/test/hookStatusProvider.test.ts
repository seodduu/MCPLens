import { describe, expect, it, vi } from 'vitest';

// Minimal vscode stub so the provider can be constructed and its tree items built.
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
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
}));

import { HookStatusProvider, toRow } from '../src/hookStatusProvider.js';

describe('toRow', () => {
  it('미설치 클라이언트는 installable + 미연결', () => {
    const r = toRow({ client: 'codex', install: 'not-installed', snapshot: undefined });
    expect(r.contextValue).toBe('hook-installable');
    expect(r.description).toContain('설치 필요');
    expect(r.client).toBe('codex');
  });
  it('설치 클라이언트는 installed', () => {
    const r = toRow({ client: 'claude-code', install: 'installed',
      snapshot: { health: 'healthy', hookObserved: true, logObserved: true,
        consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null } });
    expect(r.contextValue).toBe('hook-installed');
    expect(r.label).toContain('claude-code');
  });
});

describe('HookStatusProvider', () => {
  it('renders one row per client, excluding client-missing', () => {
    const provider = new HookStatusProvider();
    provider.setClients([
      { client: 'claude-code', install: 'installed', snapshot: undefined },
      { client: 'codex', install: 'not-installed', snapshot: undefined },
      { client: 'gemini-cli', install: 'client-missing', snapshot: undefined },
    ]);
    const roots = provider.getChildren();
    expect(roots).toHaveLength(2);
    // rows are leaves
    expect(provider.getChildren(roots[0])).toHaveLength(0);
  });

  it('renders no rows before setClients is called', () => {
    const provider = new HookStatusProvider();
    expect(provider.getChildren()).toHaveLength(0);
  });

  it('getTreeItem sets id, contextValue, description and icon from the row', () => {
    const provider = new HookStatusProvider();
    provider.setClients([{ client: 'codex', install: 'not-installed', snapshot: undefined }]);
    const [row] = provider.getChildren();
    const item = provider.getTreeItem(row) as {
      label: string; id?: string; contextValue?: string; description: string; iconPath: { id: string };
    };
    expect(item.id).toBe('codex');
    expect(item.contextValue).toBe('hook-installable');
    expect(item.description).toContain('설치 필요');
    expect(item.iconPath.id).toBe('warning');
  });

  it('색을 hook/로그 관측으로 정한다: hook 파랑 · 로그만 주황 · 없음 빨강', () => {
    const provider = new HookStatusProvider();
    const snap = (hookObserved: boolean, logObserved: boolean) => ({
      health: 'healthy' as const, hookObserved, logObserved,
      consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null });
    provider.setClients([
      { client: 'claude-code', install: 'installed', snapshot: snap(true, true) },
      { client: 'codex', install: 'installed', snapshot: snap(false, true) },
      { client: 'gemini-cli', install: 'installed', snapshot: snap(false, false) },
    ]);
    const [hook, logOnly, none] = provider.getChildren();
    const color = (row: Parameters<typeof provider.getTreeItem>[0]) =>
      (provider.getTreeItem(row).iconPath as { color: { id: string } }).color.id;
    expect(color(hook)).toBe('charts.blue');
    expect(color(logOnly)).toBe('charts.orange');
    expect(color(none)).toBe('charts.red');
  });

  it('attaches the hooksDoctor command for warning/error severity rows', () => {
    const provider = new HookStatusProvider();
    provider.setClients([{ client: 'codex', install: 'not-installed', snapshot: undefined }]);
    const [row] = provider.getChildren();
    const item = provider.getTreeItem(row) as { command?: { command: string } };
    expect(item.command?.command).toBe('mcp-lens.hooksDoctor');
  });

  it('does not attach a command for healthy severity rows', () => {
    const provider = new HookStatusProvider();
    provider.setClients([{ client: 'claude-code', install: 'installed',
      snapshot: { health: 'healthy', hookObserved: true, logObserved: true,
        consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null } }]);
    const [row] = provider.getChildren();
    const item = provider.getTreeItem(row) as { command?: unknown };
    expect(item.command).toBeUndefined();
  });
});
