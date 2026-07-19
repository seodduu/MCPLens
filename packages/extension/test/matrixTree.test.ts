import { describe, it, expect } from 'vitest';
import { buildTree } from '../src/matrixTree.js';
import type { EngineInput } from '@mcp-lens/core';

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
    expect(server.description).toBe('2회 · 100tok');
  });
});
