import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter.js';

const fx = (f: string) =>
  readFileSync(path.join(__dirname, '../../../../../fixtures/claude', f), 'utf8');

describe('ClaudeAdapter', () => {
  const a = new ClaudeAdapter();

  it('client 및 sessionRoots 계약', () => {
    expect(a.client).toBe('claude-code');
    expect(a.sessionRoots().some((p) => p.endsWith(path.join('.claude', 'projects')))).toBe(true);
  });

  it('matches는 .claude/projects 밑 jsonl만 승인', () => {
    expect(a.matches('/home/u/.claude/projects/-x-y/abc.jsonl')).toBe(true);
    expect(a.matches('/home/u/.codex/sessions/2026/r.jsonl')).toBe(false);
    expect(a.matches('/home/u/.claude/projects/-x-y/abc.json')).toBe(false);
    expect(a.matches('/home/u/.claude/todos/x.jsonl')).toBe(false);
  });

  it('sessionId는 파일 경로에 대해 결정적', () => {
    const r1 = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    const r2 = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r1.session.sessionId).toBe(r2.session.sessionId);
    expect(r1.session.sessionId).toHaveLength(16);
    expect(r1.toolCalls[0].sessionId).toBe(r1.session.sessionId);
  });

  it('tool_use/tool_result 쌍을 ToolCallEvent로 뽑고 서버/툴 이름을 분해한다', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.toolCalls.length).toBeGreaterThan(0);
    const c = r.toolCalls[0];
    expect(c.serverName).not.toContain('mcp__');
    expect(c.toolName).not.toContain('__');
    expect(c.serverName).toBe('claude_ai_PlayMCP');
    expect(c.responseText === null || typeof c.responseText === 'string').toBe(true);
    // 응답 본문이 있으면 tiktoken 추정치, 없으면 null
    if (c.responseText) expect(c.responseTokens).toBeGreaterThan(0);
    else expect(c.responseTokens).toBeNull();
    expect(typeof c.isError).toBe('boolean');
    // 내장 툴(ToolSearch/AskUserQuestion)은 toolCalls에 들어가지 않는다
    for (const tc of r.toolCalls) expect(tc.serverName).toBe('claude_ai_PlayMCP');
  });

  it('tool_reference가 있으면 DEFERRED_MEASURABLE + toolLoads 산출', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.session.mode).toBe('DEFERRED_MEASURABLE');
    expect(r.toolLoads.length).toBeGreaterThan(0);
    expect(r.toolLoads[0].loadedTokens).toBeNull(); // 조인 전엔 이름만
    expect(r.toolLoads[0].toolName.length).toBeGreaterThan(0);
    expect(r.toolLoads[0].toolName).not.toContain('__');
  });

  it('usage를 TokenUsageEvent로 적재한다', () => {
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

  it('session-upfront는 MCP 신호가 없어 DEFERRED_OPAQUE + toolCalls/toolLoads 0', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-upfront.jsonl'));
    expect(r.toolCalls.length).toBe(0);
    expect(r.toolLoads.length).toBe(0);
    expect(r.session.mode).toBe('DEFERRED_OPAQUE');
    expect(r.parseErrors).toBe(0);
    expect(r.usage.length).toBeGreaterThan(0);
  });

  it('깨진 줄은 throw 없이 parseErrors로 계수', () => {
    const r = a.parseFile('/fake/s.jsonl', 'not-json\n' + fx('session-upfront.jsonl'));
    expect(r.parseErrors).toBe(1);
  });

  it('빈 content도 throw 없이 안전 처리', () => {
    const r = a.parseFile('/fake/empty.jsonl', '');
    expect(r.parseErrors).toBe(0);
    expect(r.toolCalls).toEqual([]);
    expect(r.session.mode).toBe('DEFERRED_OPAQUE');
  });
});

describe('응답 토큰 추정 (tiktoken 폴백)', () => {
  it('응답 본문이 있는 호출은 responseTokens가 양수 추정치로 채워진다', () => {
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
