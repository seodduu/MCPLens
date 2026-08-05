import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildTree } from '../src/matrixTree.js';
import type { EngineInput, ManagedServer } from '@mcp-lens/core';

const call = (sessionId: string, server: string, tool: string, isError = false) => ({
  sessionId, serverName: server, toolName: tool, calledAt: '2026-07-10T00:00:00Z',
  durationMs: null, isError, responseTokens: 50, responseText: null });
const session = (sessionId: string, client: any) => ({
  sessionId, client, filePath: '/f', startedAt: '2026-07-10T00:00:00Z',
  mode: 'DEFERRED_MEASURABLE' as const });

describe('buildTree', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('c1', 'github', 'get_file'),
            call('x1', 'node_repl', 'js')],
    loads: [],
    sessions: [session('c1', 'claude-code'), session('x1', 'codex')],
  };

  it('클라이언트 ▸ 서버 ▸ 툴 3계층 구조를 만든다', () => {
    const roots = buildTree(input);
    expect(roots.map((r) => r.label)).toEqual(['claude-code', 'codex']);
    const claude = roots[0];
    expect(claude.kind).toBe('client');
    expect(claude.children).toHaveLength(1);           // github 서버 1개
    expect(claude.children[0].label).toBe('github');
    expect(claude.children[0].children.map((t) => t.label).sort())
      .toEqual(['get_file', 'search']);
  });

  it('툴 노드 description에 호출수·응답토큰이 들어간다', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.description).toContain('1 call');
    expect(tool.description).toContain('50 tokens');
  });

  // 권고는 아이콘으로만 전한다 — 낱말이 툴마다 반복되면 숫자가 밀린다.
  it('권고를 글로 쓰지 않아 꼬리 구분자도 남지 않는다', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.action).toBe('keep');
    expect(tool.description).not.toContain('keep');
    expect(tool.description).not.toMatch(/·\s*$/);  // 라벨을 뺀 자리에 꼬리 구분자가 남지 않는다
  });

  it('클라이언트 노드 description에 세션 수가 들어간다', () => {
    expect(buildTree(input)[0].description).toContain('1');
  });

  it('adds analysis status but exposes global disable only for independent tools', () => {
    const rows = [
      { serverName: 'github', toolName: 'search', status: 'Independent' as const, summary: 'Searches repositories.', action: 'Disable globally…' as const, canDisableGlobally: true },
      { serverName: 'github', toolName: 'get_file', status: 'Dependent' as const, canDisableGlobally: false },
    ];
    const tools = buildTree(input, new Set(), [], new Set(), rows, 'all', () => true)[0].children[0].children;
    const search = tools.find((tool) => tool.toolName === 'search')!;
    const getFile = tools.find((tool) => tool.toolName === 'get_file')!;
    expect(search).toMatchObject({ analysisStatus: 'Independent', analysisSummary: 'Searches repositories.', analysisAction: 'Disable globally…', canDisableGlobally: true });
    expect(getFile).toMatchObject({ analysisStatus: 'Dependent', canDisableGlobally: false });
    expect(getFile.analysisAction).toBeUndefined();
  });

  // 요약은 status를 길게 되풀이하는 일이 잦고 한 줄에서 제일 긴 조각이라 숫자를 밀어낸다.
  it('요약 문장은 줄에 싣지 않는다 — status만 남기고 요약은 상세 화면에 있다', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      summary: 'Tool search operates independently without being used by other tools.',
      canDisableGlobally: true }];
    const search = buildTree(input, new Set(), [], new Set(), rows)[0].children[0].children
      .find((tool) => tool.toolName === 'search')!;
    expect(search.description).toContain('Independent');
    expect(search.description).not.toContain('operates independently');
    expect(search.analysisSummary).toBe(rows[0].summary);  // 상세 화면용으로는 남는다
  });

  it('hides action rows during off rollout', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'off')[0].children[0].children
      .find((row) => row.toolName === 'search')!;
    expect(tool.canDisableGlobally).toBe(false);
    expect(tool.analysisAction).toBeUndefined();
  });

  it.each(['low confidence', 'called', 'degraded collection', 'recent restore'])
  ('hides the action context for %s eligibility failure', (reason) => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'all', () => false)[0].children[0].children
      .find((row) => row.toolName === 'search')!;
    expect(tool.canDisableGlobally, reason).toBe(false);
    expect(tool.analysisAction, reason).toBeUndefined();
  });

  it('exposes the action context for a currently eligible candidate', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'all', () => true)[0].children[0].children
      .find((row) => row.toolName === 'search')!;
    expect(tool.canDisableGlobally).toBe(true);
    expect(tool.analysisAction).toBe('Disable globally…');
  });

  it('exposes restore only for an active Lens-owned action, even when disable eligibility changed', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'all', () => false,
      (client, server, toolName) => client === 'claude-code' && server === 'github' && toolName === 'search')
      [0].children[0].children.find((row) => row.toolName === 'search')!;
    expect(tool).toMatchObject({ canDisableGlobally: false, canRestoreGlobally: true, analysisAction: 'Restore globally' });
  });

  it('hides both global action contexts for active actions during off rollout', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'off', () => true, () => true)
      [0].children[0].children.find((row) => row.toolName === 'search')!;
    expect(tool).toMatchObject({ canDisableGlobally: false, canRestoreGlobally: false });
    expect(tool.analysisAction).toBeUndefined();
  });

  it('does not expose legacy tool or server actions in the v2 matrix menu', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const matrixCommands = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('view == mcpLens.matrix'))
      .map((item: { command: string }) => item.command);
    expect(matrixCommands).not.toEqual(expect.arrayContaining([
      'mcp-lens.removeTool', 'mcp-lens.addTool',
      'mcp-lens.removeServer', 'mcp-lens.addServer',
    ]));
  });

  it('uses distinct manifest contexts for disable and restore', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const matrixItems = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('view == mcpLens.matrix'));
    expect(matrixItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'mcplens.disableGlobally', when: expect.stringContaining('mcpAnalysis-disable') }),
      expect.objectContaining({ command: 'mcplens.restoreGlobally', when: expect.stringContaining('mcpAnalysis-restore') }),
    ]));
  });

  // 두 액션 모두 행에 마우스를 올리면 바로 보인다 (우클릭 메뉴에 숨기지 않는다).
  it('exposes both matrix actions inline on hover', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const matrixItems = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('view == mcpLens.matrix'));
    for (const command of ['mcplens.disableGlobally', 'mcplens.restoreGlobally']) {
      expect(matrixItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ command, group: 'inline' }),
      ]));
    }
  });

  it('로드만 되고 호출 0인 툴도 정의 토큰을 누적 비용으로 표시한다', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(loadedOnly)[0].children[0].children[0];
    expect(tool.description).toContain('3,287 tokens');
    expect(tool.description).not.toContain('0 tokens');
  });

  it('로드만 되고 호출 0인 툴은 searchedNotCalled로 표시한다', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(loadedOnly)[0].children[0].children[0];
    expect(tool.searchedNotCalled).toBe(true);
  });

  it('호출된 툴은 searchedNotCalled가 아니다', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js (호출됨)
    expect(tool.searchedNotCalled).toBeFalsy();
  });

  it('로드 세션 수만큼 정의 비용을 곱한다', () => {
    const threeSessions: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 1000, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: ['c1', 'c2', 'c3'].map((s) => ({ sessionId: s, serverName: 'notion',
        toolName: 'notion-update-page', loadedTokens: null })),
      sessions: [session('c1', 'claude-code'), session('c2', 'claude-code'),
        session('c3', 'claude-code')],
    };
    const tool = buildTree(threeSessions)[0].children[0].children[0];
    expect(tool.description).toContain('3,000 tokens');
  });

  it('로드 기록이 없어도 호출된 세션 수로 정의 비용을 역산한다', () => {
    const hookOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-search',
        definitionTokens: 1721, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [call('c1', 'notion', 'notion-search'), call('c2', 'notion', 'notion-search')],
      loads: [],
      sessions: [session('c1', 'claude-code'), session('c2', 'claude-code')],
    };
    const tool = buildTree(hookOnly)[0].children[0].children[0];
    // 정의 1721 × 2세션 = 3442, 응답 50 × 2회 = 100 → 합계 3542
    expect(tool.description).toContain('3,542 tokens');
  });

  // 미측정 = 정의 토큰이 빠진 값 = 하한. 긴 괄호 문구 대신 ≥ 한 글자로 같은 사실을 말한다.
  it('정의 토큰 미측정이면 응답분을 하한값(≥)으로 표시한다', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.description).toContain('≥50 tokens');
    expect(tool.description).not.toContain('not measured');
  });

  it('권고는 글로 쓰지 않는다 — 판정은 action 필드로만 나가고 아이콘이 전한다', () => {
    const lowConfidence: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(lowConfidence)[0].children[0].children[0];
    expect(tool).toMatchObject({ action: 'remove', confidence: 'low' });
    expect(tool.description).not.toContain('remove');
    expect(tool.description).not.toContain('candidate');
  });

  it('로드만 되고 호출 0인 툴이 있을 때 클라이언트 노드가 0이 아니라 자식 합을 표시한다', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const [clientNode] = buildTree(loadedOnly);
    const toolNode = clientNode.children[0].children[0];
    // 클라이언트 노드는 접혀 있어도 자식(툴)과 모순되지 않아야 한다 —
    // 응답 토큰 합(0)이 아니라 서버·툴 노드와 동일한 누적 비용 fold를 써야 한다.
    expect(clientNode.description).toContain('3,287 tokens');
    expect(clientNode.description).not.toContain('0 tokens');
    expect(clientNode.description).toContain(toolNode.description.match(/[\d,.]+k? tokens/)![0]);
  });

  it('서버 노드 누적 비용은 자식 툴들의 합과 같다', () => {
    const twoTools: EngineInput = {
      definitions: [
        { serverName: 'notion', toolName: 'notion-update-page', definitionTokens: 3287,
          scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' },
        { serverName: 'notion', toolName: 'notion-create-pages', definitionTokens: 2526,
          scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' },
      ],
      calls: [],
      loads: [
        { sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page', loadedTokens: null },
        { sessionId: 'c1', serverName: 'notion', toolName: 'notion-create-pages', loadedTokens: null },
      ],
      sessions: [session('c1', 'claude-code')],
    };
    const server = buildTree(twoTools)[0].children[0];
    expect(server.description).toContain('5,813 tokens');   // 3287 + 2526
  });
});

describe('비용 내림차순 정렬', () => {
  const def = (server: string, tool: string, tokens: number) => ({
    serverName: server, toolName: tool, definitionTokens: tokens,
    scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });
  const load = (server: string, tool: string) => ({
    sessionId: 'c1', serverName: server, toolName: tool, loadedTokens: null });

  // 등장 순서(small → big)와 반대로 정렬돼야 한다.
  const input: EngineInput = {
    definitions: [def('small', 'a', 100), def('big', 'x', 9000), def('big', 'y', 500)],
    calls: [],
    loads: [load('small', 'a'), load('big', 'x'), load('big', 'y')],
    sessions: [session('c1', 'claude-code')],
  };

  it('서버를 비용 큰 순으로 놓는다', () => {
    const [client] = buildTree(input);
    expect(client.children.map((s) => s.label)).toEqual(['big', 'small']);
  });

  it('서버 안의 툴도 비용 큰 순으로 놓는다', () => {
    const big = buildTree(input)[0].children.find((s) => s.label === 'big')!;
    expect(big.children.map((t) => t.label)).toEqual(['x', 'y']);
  });

  it('사용 이력 없는 managed 서버는 0 tokens이므로 뒤로 간다', () => {
    const [client] = buildTree(input, new Set(), [{ name: 'idle', enabled: true, origins: ['user'] }]);
    expect(client.children.map((s) => s.label)).toEqual(['big', 'small', 'idle']);
  });

  it('비용이 같으면 이름 오름차순 — 갱신마다 자리가 흔들리지 않는다', () => {
    const tie: EngineInput = {
      definitions: [def('zeta', 'a', 500), def('alpha', 'a', 500)],
      calls: [], loads: [load('zeta', 'a'), load('alpha', 'a')],
      sessions: [session('c1', 'claude-code')],
    };
    expect(buildTree(tie)[0].children.map((s) => s.label)).toEqual(['alpha', 'zeta']);
  });
});

describe('토큰 표기 축약', () => {
  const oneTool = (tokens: number): EngineInput => ({
    definitions: [{ serverName: 'notion', toolName: 'big', definitionTokens: tokens,
      scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' }],
    calls: [],
    loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'big', loadedTokens: null }],
    sessions: [session('c1', 'claude-code')],
  });

  it('1만 이상은 k로 줄인다 — 트리는 비례폭이라 긴 자릿수가 비교에 도움이 안 된다', () => {
    const tool = buildTree(oneTool(126_604))[0].children[0].children[0];
    expect(tool.description).toContain('126.6k tokens');
    expect(tool.description).not.toContain('126,604');
  });

  it('1만 미만은 전체 자릿수를 유지한다', () => {
    const tool = buildTree(oneTool(9_999))[0].children[0].children[0];
    expect(tool.description).toContain('9,999 tokens');
  });
});

describe('집계 표시', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('c1', 'github', 'get_file')],
    loads: [],
    sessions: [session('c1', 'claude-code')],
  };
  it('클라이언트 노드에 총 호출수·응답토큰 합이 들어간다', () => {
    const client = buildTree(input)[0];
    expect(client.description).toContain('total 2 calls');
    expect(client.description).toContain('100 tokens'); // 50 + 50
  });
  it('서버 노드에 호출수·응답토큰 합이 들어간다', () => {
    const server = buildTree(input)[0].children[0];
    // 미측정 표기는 툴 노드에만 — 상위 노드에서 반복되면 잡음이 된다
    expect(server.description).toBe('2 calls · 100 tokens');
  });

  it('미측정 표기는 서버·클라이언트 노드에 나타나지 않는다', () => {
    const roots = buildTree(input);
    expect(roots[0].description).not.toContain('≥');
    expect(roots[0].children[0].description).not.toContain('≥');
    // 툴 노드에는 그대로 남는다
    expect(roots[0].children[0].children[0].description).toContain('≥');
  });
});

describe('실패 표기 (실패만 괄호로)', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'flaky', true), call('c1', 'github', 'flaky', true),
            call('c1', 'github', 'ok')],
    loads: [],
    sessions: [session('c1', 'claude-code')],
  };
  it('실패 있는 툴/서버/클라이언트는 (실패 N) 표기', () => {
    const client = buildTree(input)[0];
    expect(client.description).toContain('total 3 calls (2 failed)');
    expect(client.children[0].description).toContain('3 calls (2 failed)');
    const flaky = client.children[0].children.find((t) => t.label === 'flaky')!;
    expect(flaky.description).toContain('2 calls (2 failed)');
  });
  it('실패 0인 툴은 괄호 없이 깔끔하게', () => {
    const ok = buildTree(input)[0].children[0].children.find((t) => t.label === 'ok')!;
    expect(ok.description).toContain('1 call ·');
    expect(ok.description).not.toContain('failed');
  });
});

describe('deny 토글 표시', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('c1', 'github', 'get_file'),
            call('x1', 'github', 'search')],
    loads: [],
    sessions: [session('c1', 'claude-code'), session('x1', 'codex')],
  };
  const denied = new Set(['mcp__github__search']);

  it('claude-code 툴 노드에 client/serverName/toolName이 채워진다', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'search')!;
    expect(tool.client).toBe('claude-code');
    expect(tool.serverName).toBe('github');
    expect(tool.toolName).toBe('search');
  });
  it('deny된 claude-code 툴은 enabled=false + description에 차단됨', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'search')!;
    expect(tool.enabled).toBe(false);
    expect(tool.description).toContain('Disabled');
  });
  it('deny 안 된 claude-code 툴은 enabled=true', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'get_file')!;
    expect(tool.enabled).toBe(true);
    expect(tool.description).not.toContain('Disabled');
  });
  it('codex 툴은 같은 서버·툴이라도 enabled=undefined (범위 제외)', () => {
    const codexTool = buildTree(input, denied)[1].children[0].children[0];
    expect(codexTool.enabled).toBeUndefined();
  });
  it('deniedRules 생략 시 기존 동작 그대로 (전부 enabled=true)', () => {
    const tool = buildTree(input)[0].children[0].children[0];
    expect(tool.enabled).toBe(true);
  });
});

describe('서버 단위 토글 표시', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('x1', 'github', 'search')],
    loads: [],
    sessions: [session('c1', 'claude-code'), session('x1', 'codex')],
  };
  const m = (name: string, enabled: boolean): ManagedServer =>
    ({ name, enabled, origins: ['user'] });

  it('managed 서버의 enabled가 서버 노드에 반영된다', () => {
    const server = buildTree(input, new Set(), [m('github', true)])[0].children[0];
    expect(server.enabled).toBe(true);
    expect(server.serverName).toBe('github');
  });
  it('disabled 서버는 description에 차단됨 + 하위 툴 메뉴 숨김(enabled 미부여)', () => {
    const server = buildTree(input, new Set(), [m('github', false)])[0].children[0];
    expect(server.enabled).toBe(false);
    expect(server.description).toContain('Disabled');
    expect(server.children[0].enabled).toBeUndefined();
  });
  it('managed에 없는 서버(claude.ai 커넥터 등)는 enabled=undefined (메뉴 미노출)', () => {
    const server = buildTree(input, new Set(), [])[0].children[0];
    expect(server.enabled).toBeUndefined();
  });
  it('codex 클라이언트에는 managed가 적용되지 않는다', () => {
    const server = buildTree(input, new Set(), [m('github', false)])[1].children[0];
    expect(server.enabled).toBeUndefined();
  });
  it('사용 이력 없는 managed 서버는 0회 노드로 추가된다', () => {
    const claude = buildTree(input, new Set(), [m('github', true), m('lenstest', false)])[0];
    const zero = claude.children.find((s) => s.label === 'lenstest')!;
    expect(zero.description).toBe('0 calls · 0 tokens · Disabled');
    expect(zero.enabled).toBe(false);
    expect(zero.children).toEqual([]);
  });
  it('claude-code 세션이 없어도 0회 서버로 클라이언트 노드를 만든다', () => {
    const noClaude: EngineInput = { definitions: [], calls: [], loads: [], sessions: [] };
    const roots = buildTree(noClaude, new Set(), [m('lenstest', true)]);
    const claude = roots.find((r) => r.id === 'claude-code')!;
    expect(claude.description).toContain('0 sessions');
    expect(claude.children.map((s) => s.label)).toEqual(['lenstest']);
  });
});

describe('낭비 개수 표시', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const upfront = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const def = (tool: string, tokens: number) => ({
    serverName: 'notion', toolName: tool, definitionTokens: tokens,
    scannedAt: at(0), firstScannedAt: at(0) });

  it('서버 노드 description에 낭비 툴 개수가 붙는다', () => {
    const [client] = buildTree({
      definitions: [def('a', 800), def('b', 800)], calls: [], loads: [], sessions: upfront(12) });
    expect(client.children[0].description).toContain('2 waste');
  });

  it('클라이언트 노드 description에 낭비 툴 합이 붙는다', () => {
    const [client] = buildTree({
      definitions: [def('a', 800), def('b', 800)], calls: [], loads: [], sessions: upfront(12) });
    expect(client.description).toContain('2 waste');
  });

  it('낭비 0인 서버·클라이언트에는 낭비 문구가 없다', () => {
    const noWaste: EngineInput = {
      definitions: [], calls: [call('c1', 'github', 'search')], loads: [],
      sessions: [session('c1', 'claude-code')] };
    const [client] = buildTree(noWaste);
    expect(client.description).not.toContain('waste');
    expect(client.children[0].description).not.toContain('waste');
  });
});

describe('업프론트 클라이언트 세션당 정의 부담 표시', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const upfront = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'gemini-cli' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const def = (tool: string, tokens: number) => ({
    serverName: 'tiny', toolName: tool, definitionTokens: tokens,
    scannedAt: at(0), firstScannedAt: at(0) });

  const upcall = (sessionId: string, tool: string) => ({
    sessionId, serverName: 'tiny', toolName: tool, calledAt: at(0),
    durationMs: null, isError: false, responseTokens: 50, responseText: null });

  it('업프론트 미호출 툴은 0이 아니라 세션당 정의 부담으로 표시한다', () => {
    // 로드 이벤트가 없어 loadSessions=0 → 누적은 0 tokens이 되지만, 매 세션 로드되는 부담이 있다.
    const [client] = buildTree({
      definitions: [def('a', 800)], calls: [], loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).toContain('800 tokens/session');
  });

  // "3 calls · calls 0 tokens"은 호출을 두 번 말하면서 0이라는 빈 값을 싣는 꼴이다.
  it('응답 토큰이 0이면 호출 비용 조각을 통째로 뺀다', () => {
    const [client] = buildTree({
      definitions: [def('a', 800)], calls: [], loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).not.toContain('calls 0 tokens');
    // 한쪽만 남으면 라벨도 필요 없다 — /session이 정의임을 이미 밝힌다
    expect(tool.description).not.toContain('definition ');
  });

  it('호출 비용은 세션당이 아니라 누적 — 세션 수를 곱하지 않는다', () => {
    // a를 2세션에서 3회 호출(응답 50×3=150 누적). 정의는 세션당 800.
    const [client] = buildTree({
      definitions: [def('a', 800)],
      calls: [upcall('s0', 'a'), upcall('s0', 'a'), upcall('s1', 'a')],
      loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).toContain('calls 150 tokens');     // 50×3 누적
    expect(tool.description).toContain('definition 800 tokens/session'); // 세션 수 미승산
    expect(tool.description).not.toContain('4,000');       // 800×5 아님
  });

  it('서버·클라이언트 롤업도 호출·정의 분리로 표기한다', () => {
    const [client] = buildTree({
      definitions: [def('a', 800), def('b', 200)], calls: [], loads: [], sessions: upfront(5) });
    expect(client.children[0].description).toContain('1,000 tokens/session'); // 800+200
    expect(client.description).toContain('1,000 tokens/session');
  });

  it('정의 1토큰짜리 더미 툴도 0이 아니라 1 token/세션으로 보인다', () => {
    const [client] = buildTree({
      definitions: [def('a', 1), def('b', 1), def('c', 1)], calls: [], loads: [],
      sessions: upfront(5) });
    for (const t of client.children[0].children)
      expect(t.description).toContain('1 token/session');
  });

  it('정의 미측정 툴은 0 tokens/세션이 아니라 "정의 미측정"만 표기한다', () => {
    // 스캐너가 못 잡은 툴이 업프론트에서 호출됨 → 정의 토큰 null.
    const [client] = buildTree({
      definitions: [], calls: [upcall('s0', 'a')], loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).toContain('calls 50 tokens');
    expect(tool.description).toContain('definition unmeasured');
    expect(tool.description).not.toContain('0 tokens/session');
    expect(tool.description).not.toContain('definition 0 tokens');
  });

  it('지연 로딩 클라이언트는 여전히 누적(/세션·호출 라벨 없음)으로 표시한다 — 회귀', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(loadedOnly)[0].children[0].children[0];
    expect(tool.description).toContain('3,287 tokens');
    expect(tool.description).not.toContain('/session');
    expect(tool.description).not.toContain('calls 0 tokens'); // 지연 로딩은 누적 단일값
  });
});

describe('지원하지 않는 서버 숨김 (excludeServers)', () => {
  const m = (name: string, enabled: boolean): ManagedServer =>
    ({ name, enabled, origins: ['user'] });

  it('excludeServers에 든 서버는 사용 이력이 있어도 트리에서 빠진다', () => {
    const input: EngineInput = {
      definitions: [],
      calls: [call('c1', 'github', 'search'), call('c1', 'figma', 'get_file')],
      loads: [],
      sessions: [session('c1', 'claude-code')],
    };
    const [claude] = buildTree(input, new Set(), [], new Set(['figma']));
    expect(claude.children.map((s) => s.label)).toEqual(['github']);
  });

  it('excludeServers에 든 서버는 0회 managed 노드로도 나타나지 않는다', () => {
    const input: EngineInput = { definitions: [], calls: [], loads: [], sessions: [] };
    const roots = buildTree(input, new Set(), [m('figma', true), m('github', true)], new Set(['figma']));
    const claude = roots.find((r) => r.id === 'claude-code')!;
    expect(claude.children.map((s) => s.label)).toEqual(['github']);
  });

  it('excludeServers 생략 시 기존 동작 그대로', () => {
    const input: EngineInput = {
      definitions: [], calls: [call('c1', 'figma', 'x')], loads: [],
      sessions: [session('c1', 'claude-code')] };
    const [claude] = buildTree(input);
    expect(claude.children.map((s) => s.label)).toEqual(['figma']);
  });
});

describe('확신 등급 렌더링', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const sess = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const unusedDef = {
    serverName: 'github', toolName: 'unused', definitionTokens: 800,
    scannedAt: at(0), firstScannedAt: at(0) };

  const toolNode = (sessionCount: number) => {
    const [client] = buildTree({
      definitions: [unusedDef], calls: [], loads: [], sessions: sess(sessionCount) });
    return client.children[0].children[0];
  };

  it('확신 높은 remove는 확신 등급을 high로 내놓는다', () => {
    const node = toolNode(12);
    expect(node.confidence).toBe('high');
    expect(node.action).toBe('remove');
  });

  // 확신이 낮으면 lensTreeProvider가 권고 아이콘 자체를 억제한다 — 강등을 글로 쓰지 않는다.
  it('확신 낮은 remove는 확신 등급을 low로 내놓는다', () => {
    const node = toolNode(2);
    expect(node.confidence).toBe('low');
    expect(node.description).not.toContain('candidate');
  });

  // splitByClient가 lastCallByTool을 버리면 이 툴은 "한 번도 안 쓴 툴"로 둔갑해 high가 난다.
  it('창 밖 과거 호출 이력이 있으면 medium (high 아님) — lastCallByTool이 엔진까지 도달한다', () => {
    const [client] = buildTree({
      definitions: [unusedDef], calls: [], loads: [], sessions: sess(12),
      lastCallByTool: new Map([['github unused', '2026-03-14T09:00:00Z']]),
    });
    const node = client.children[0].children[0];
    expect(node.action).toBe('remove');
    expect(node.confidence).toBe('medium');
    expect(node.confidence).not.toBe('high');
    expect(node.description).not.toContain('candidate');
  });
});
