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
  it('미설치 클라이언트는 installable + 미연결', () => {
    const r = toRow({ client: 'codex', install: 'not-installed', snapshot: undefined });
    expect(r.contextValue).toBe('hook-installable');
    expect(r.description).toContain('Install needed');
    expect(r.client).toBe('codex');
  });
  it('설치 클라이언트는 installed', () => {
    const r = toRow({ client: 'claude-code', install: 'installed', snapshot: healthy });
    expect(r.contextValue).toBe('hook-installed');
    expect(r.label).toContain('claude-code');
  });
});

describe('collectionRows', () => {
  it('클라이언트마다 한 행, client-missing은 제외', () => {
    const rows = collectionRows([
      { client: 'claude-code', install: 'installed', snapshot: undefined },
      { client: 'codex', install: 'not-installed', snapshot: undefined },
      { client: 'gemini-cli', install: 'client-missing', snapshot: undefined },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['claude-code', 'codex']);
  });

  it('모든 행이 Setup Status의 Collection 그룹에 들어간다', () => {
    const rows = collectionRows([{ client: 'codex', install: 'not-installed', snapshot: undefined }]);
    expect(rows.every((r) => r.group === 'Collection')).toBe(true);
  });

  it('색을 hook/로그 관측으로 정한다: hook 파랑 · 로그만 주황 · 없음 빨강', () => {
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

  it('경고·오류 행에만 hooksDoctor 커맨드를 단다', () => {
    const [warn] = collectionRows([{ client: 'codex', install: 'not-installed', snapshot: undefined }]);
    expect(warn.command).toBe('mcp-lens.hooksDoctor');
    expect(warn.commandArgs).toEqual(['codex']);
  });

  it('정상 행에는 커맨드를 달지 않는다 — 고칠 게 없는 행이다', () => {
    const [ok] = collectionRows([{ client: 'claude-code', install: 'installed', snapshot: healthy }]);
    expect(ok.command).toBeUndefined();
  });
});

describe('Setup Status 뷰의 Collection 그룹 렌더링', () => {
  const provider = () => {
    const p = new SetupStatusProvider();
    p.setRows(collectionRows([
      { client: 'codex', install: 'not-installed', snapshot: undefined },
      { client: 'claude-code', install: 'installed', snapshot: healthy },
    ]));
    return p;
  };
  const rowsOf = (p: SetupStatusProvider) => p.getChildren(p.getChildren()[0]);

  it('Collection이 첫 그룹 — 수집이 안 되면 나머지 숫자를 믿을 수 없다', () => {
    const [first] = provider().getChildren();
    expect(first.kind === 'group' && first.group).toBe('Collection');
  });

  it('행에 id·contextValue·description·아이콘·색을 채운다', () => {
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

  it('hooksDoctor는 서버 이름 객체가 아니라 클라이언트 이름을 받는다', () => {
    const p = provider();
    const item = p.getTreeItem(rowsOf(p)[0]);
    expect(item.command?.command).toBe('mcp-lens.hooksDoctor');
    expect(item.command?.arguments).toEqual(['codex']);
  });

  it('설치 클라이언트에는 uninstall 메뉴용 contextValue가 붙는다', () => {
    const p = provider();
    expect(p.getTreeItem(rowsOf(p)[1]).contextValue).toBe('hook-installed');
  });
});

describe('훅 메뉴 라우팅 매니페스트', () => {
  it('설치·제거 메뉴가 Setup Status 뷰를 가리킨다', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const hookItems = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('hook-install'));
    expect(hookItems).toHaveLength(2);
    for (const item of hookItems) expect(item.when).toContain('view == mcpLens.setupStatus');
    // 옛 뷰는 매니페스트에서 사라졌다 — 남아 있으면 빈 섹션이 다시 생긴다.
    expect(manifest.contributes.views.mcpLens.map((v: { id: string }) => v.id))
      .not.toContain('mcpLens.collection');
  });
});
