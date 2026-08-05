import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter.js';

const fx = (f: string) =>
  readFileSync(path.join(__dirname, '../../../../../fixtures/claude', f), 'utf8');

describe('ClaudeAdapter', () => {
  const a = new ClaudeAdapter();

  it('honours the client and sessionRoots contract', () => {
    expect(a.client).toBe('claude-code');
    expect(a.sessionRoots().some((p) => p.endsWith(path.join('.claude', 'projects')))).toBe(true);
  });

  it('matches only jsonl files under .claude/projects', () => {
    expect(a.matches('/home/u/.claude/projects/-x-y/abc.jsonl')).toBe(true);
    expect(a.matches('/home/u/.codex/sessions/2026/r.jsonl')).toBe(false);
    expect(a.matches('/home/u/.claude/projects/-x-y/abc.json')).toBe(false);
    expect(a.matches('/home/u/.claude/todos/x.jsonl')).toBe(false);
  });

  it('derives sessionId deterministically from the file path', () => {
    const r1 = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    const r2 = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r1.session.sessionId).toBe(r2.session.sessionId);
    expect(r1.session.sessionId).toHaveLength(16);
    expect(r1.toolCalls[0].sessionId).toBe(r1.session.sessionId);
  });

  it('preserves the fixture native sessionId as externalSessionId', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));

    expect(r.session.externalSessionId).toBe('cdef9879-14b5-4044-a9ea-31f0986cfc48');
  });

  it('extracts tool_use/tool_result pairs as ToolCallEvents and splits the server and tool names', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.toolCalls.length).toBeGreaterThan(0);
    const c = r.toolCalls[0];
    expect(c.serverName).not.toContain('mcp__');
    expect(c.toolName).not.toContain('__');
    expect(c.serverName).toBe('claude_ai_PlayMCP');
    expect(c.externalCallId).toBe('toolu_01XpoajJqCnxc7TBh4SJFjjG');
    expect(c.responseText === null || typeof c.responseText === 'string').toBe(true);
    // A tiktoken estimate when the response body exists, null otherwise
    if (c.responseText) expect(c.responseTokens).toBeGreaterThan(0);
    else expect(c.responseTokens).toBeNull();
    expect(typeof c.isError).toBe('boolean');
    // Builtin tools (ToolSearch/AskUserQuestion) never enter toolCalls
    for (const tc of r.toolCalls) expect(tc.serverName).toBe('claude_ai_PlayMCP');
  });

  it('produces DEFERRED_MEASURABLE and toolLoads when tool_reference is present', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.session.mode).toBe('DEFERRED_MEASURABLE');
    expect(r.toolLoads.length).toBeGreaterThan(0);
    expect(r.toolLoads[0].loadedTokens).toBeNull(); // only the name before the join
    expect(r.toolLoads[0].toolName.length).toBeGreaterThan(0);
    expect(r.toolLoads[0].toolName).not.toContain('__');
  });

  it('ingests usage as TokenUsageEvents', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.usage.length).toBeGreaterThan(0);
    expect(r.usage[0].inputTokens).toBeGreaterThanOrEqual(0);
    expect(r.usage[0].sessionId).toBe(r.session.sessionId);
    for (const u of r.usage) {
      expect(typeof u.outputTokens).toBe('number');
      expect(typeof u.cacheReadTokens).toBe('number');
      expect(typeof u.cacheCreationTokens).toBe('number');
    }
  });

  it('gives session-upfront DEFERRED_OPAQUE with 0 toolCalls/toolLoads, since it has no MCP signal', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-upfront.jsonl'));
    expect(r.toolCalls.length).toBe(0);
    expect(r.toolLoads.length).toBe(0);
    expect(r.session.mode).toBe('DEFERRED_OPAQUE');
    expect(r.parseErrors).toBe(0);
    expect(r.usage.length).toBeGreaterThan(0);
  });

  it('counts a broken line as a parseError instead of throwing', () => {
    const r = a.parseFile('/fake/s.jsonl', 'not-json\n' + fx('session-upfront.jsonl'));
    expect(r.parseErrors).toBe(1);
  });

  it('handles empty content safely without throwing', () => {
    const r = a.parseFile('/fake/empty.jsonl', '');
    expect(r.parseErrors).toBe(0);
    expect(r.toolCalls).toEqual([]);
    expect(r.session.mode).toBe('DEFERRED_OPAQUE');
  });

  it('normalizes blank native session/call IDs to null', () => {
    const content = [
      JSON.stringify({
        sessionId: '   ', timestamp: '2026-07-20T00:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: '\t', name: 'mcp__server__tool' }] },
      }),
      JSON.stringify({
        sessionId: ' ', timestamp: '2026-07-20T00:00:01.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: '\t', content: 'ok' }] },
      }),
    ].join('\n');

    const r = a.parseFile('/fake/blank.jsonl', content);

    expect(r.session.externalSessionId).toBeNull();
    expect(r.toolCalls[0].externalCallId).toBeNull();
  });
});

describe('response token estimation (the tiktoken fallback)', () => {
  it('fills responseTokens with a positive estimate for a call with a response body', () => {
    const a = new ClaudeAdapter();
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    const withBody = r.toolCalls.filter((c) => c.responseText && c.responseText.length > 0);
    expect(withBody.length).toBeGreaterThan(0);
    for (const c of withBody) {
      expect(c.responseTokens).not.toBeNull();
      expect(c.responseTokens!).toBeGreaterThan(0);
    }
  });
});
