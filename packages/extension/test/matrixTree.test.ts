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

  it('툴 노드 description에 호출수·응답토큰·권고가 들어간다', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.description).toContain('1회');
    expect(tool.description).toContain('50tok');
    expect(tool.description).toContain('keep');
  });

  it('클라이언트 노드 description에 세션 수가 들어간다', () => {
    expect(buildTree(input)[0].description).toContain('1');
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
    expect(tool.description).toContain('3,287tok');
    expect(tool.description).not.toContain('0tok');
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
    expect(tool.description).toContain('3,000tok');
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
    expect(tool.description).toContain('3,542tok');
  });

  it('정의 토큰 미측정이면 응답분은 남기고 미측정을 표시한다', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.description).toContain('50tok');
    expect(tool.description).toContain('정의 미측정');
  });

  it('확신이 낮은 권고는 물음표 없이 (후보)로 표시한다', () => {
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
    expect(tool.description).toContain('remove (후보)');
    expect(tool.description).not.toContain('?');
  });

  it('로드만 되고 호출 0인 툴이 있을 때 클라이언트 노드가 0tok이 아니라 자식 합을 표시한다', () => {
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
    expect(clientNode.description).toContain('3,287tok');
    expect(clientNode.description).not.toContain('0tok');
    expect(clientNode.description).toContain(toolNode.description.match(/[\d,]+tok/)![0]);
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
    expect(server.description).toContain('5,813tok');   // 3287 + 2526
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
    expect(client.description).toContain('총 2회');
    expect(client.description).toContain('100tok'); // 50 + 50
  });
  it('서버 노드에 호출수·응답토큰 합이 들어간다', () => {
    const server = buildTree(input)[0].children[0];
    // 정의 토큰 미측정 — 자식 툴과 동일하게 응답분만 담고 미측정을 표시한다
    expect(server.description).toBe('2회 · 100tok(정의 미측정)');
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
    expect(client.description).toContain('총 3회(실패 2)');
    expect(client.children[0].description).toContain('3회(실패 2)');
    const flaky = client.children[0].children.find((t) => t.label === 'flaky')!;
    expect(flaky.description).toContain('2회(실패 2)');
  });
  it('실패 0인 툴은 괄호 없이 깔끔하게', () => {
    const ok = buildTree(input)[0].children[0].children.find((t) => t.label === 'ok')!;
    expect(ok.description).toContain('1회 ·');
    expect(ok.description).not.toContain('실패');
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
    expect(tool.description).toContain('차단됨');
  });
  it('deny 안 된 claude-code 툴은 enabled=true', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'get_file')!;
    expect(tool.enabled).toBe(true);
    expect(tool.description).not.toContain('차단됨');
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
    expect(server.description).toContain('차단됨');
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
    expect(zero.description).toBe('0회 · 0tok · 차단됨');
    expect(zero.enabled).toBe(false);
    expect(zero.children).toEqual([]);
  });
  it('claude-code 세션이 없어도 0회 서버로 클라이언트 노드를 만든다', () => {
    const noClaude: EngineInput = { definitions: [], calls: [], loads: [], sessions: [] };
    const roots = buildTree(noClaude, new Set(), [m('lenstest', true)]);
    const claude = roots.find((r) => r.id === 'claude-code')!;
    expect(claude.description).toContain('세션 0개');
    expect(claude.children.map((s) => s.label)).toEqual(['lenstest']);
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

  it('확신 높은 remove는 action 그대로 표시된다', () => {
    const node = toolNode(12);
    expect(node.confidence).toBe('high');
    expect(node.description).toContain('remove');
    expect(node.description).not.toContain('후보');
  });

  it('확신 낮은 remove는 "후보" 라벨로 표시된다', () => {
    const node = toolNode(2);
    expect(node.confidence).toBe('low');
    expect(node.description).toContain('후보');
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
    expect(node.description).not.toContain('후보'); // 표시 강등은 low만
    expect(node.tooltip).toContain('2026-03-14');
  });
});
