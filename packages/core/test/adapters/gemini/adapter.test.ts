import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { geminiAdapter, splitFlattenedName } from '../../../src/adapters/gemini/adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  here,
  '../../../../../fixtures/gemini/chat-upfront.jsonl',
);
const fixture = readFileSync(fixturePath, 'utf8');

describe('splitFlattenedName', () => {
  it('mcp_ 접두어 벗기고 첫 _에서 서버/툴 분리', () => {
    expect(splitFlattenedName('mcp_github_list_issues')).toEqual({
      server: 'github',
      tool: 'list_issues',
    });
  });
  it('픽스처의 이름도 올바르게 분해', () => {
    expect(splitFlattenedName('mcp_lenstest_lens_get_weather')).toEqual({
      server: 'lenstest',
      tool: 'lens_get_weather',
    });
  });
  it('mcp_ 접두어 없는 내장 툴은 null', () => {
    expect(splitFlattenedName('read_file')).toBeNull();
  });
  it('mcp_ 뒤 _ 없는 잔여 문자열은 server=tool=rest', () => {
    expect(splitFlattenedName('mcp_solo')).toEqual({ server: 'solo', tool: 'solo' });
  });
});

describe('geminiAdapter.matches', () => {
  const root = path.join(os.homedir(), '.gemini', 'tmp');
  it('.gemini/tmp/<hash>/chats/*.jsonl 승인', () => {
    expect(geminiAdapter.matches(path.join(root, 'abc123', 'chats', 's.jsonl'))).toBe(true);
  });
  it('.json 확장자도 승인', () => {
    expect(geminiAdapter.matches(path.join(root, 'abc123', 'chats', 's.json'))).toBe(true);
  });
  it('chats 밖 경로는 거부', () => {
    expect(geminiAdapter.matches(path.join(root, 'abc123', 'notes', 's.jsonl'))).toBe(false);
  });
  it('다른 클라이언트 로그는 거부', () => {
    expect(
      geminiAdapter.matches(path.join(os.homedir(), '.claude', 'projects', 'x.jsonl')),
    ).toBe(false);
  });
});

describe('geminiAdapter.parseFile — 픽스처 chat-upfront.jsonl', () => {
  const result = geminiAdapter.parseFile(fixturePath, fixture);

  it('파싱 에러 없음', () => {
    expect(result.parseErrors).toBe(0);
  });

  it('MCP toolCall이 1개(중복 레코드에서도 dedup)', () => {
    expect(result.toolCalls.length).toBe(1);
    const tc = result.toolCalls[0];
    expect(tc.serverName).toBe('lenstest');
    expect(tc.toolName).toBe('lens_get_weather');
    expect(tc.isError).toBe(false);
    expect(tc.calledAt).toBe('2026-07-18T17:16:49.857Z');
    expect(tc.responseTokens).toBe(0);
    expect(tc.externalCallId).toBe('mcp_lenstest_lens_get_weather__1jlcieln');
  });

  it('responseText에 untrusted_context 래퍼 포함', () => {
    expect(result.toolCalls[0].responseText).toContain('untrusted_context');
  });

  it('mode는 UPFRONT, toolLoads는 빈 배열', () => {
    expect(result.session.mode).toBe('UPFRONT');
    expect(result.toolLoads).toEqual([]);
  });

  it('세션 메타: client, startedAt, sessionId(파일경로 sha256 앞16)', () => {
    expect(result.session.client).toBe('gemini-cli');
    expect(result.session.startedAt).toBe('2026-07-18T17:16:43.930Z');
    expect(result.session.filePath).toBe(fixturePath);
    const expectedId = crypto
      .createHash('sha256')
      .update(fixturePath)
      .digest('hex')
      .slice(0, 16);
    expect(result.session.sessionId).toBe(expectedId);
    expect(result.session.externalSessionId).toBe('b0b95759-2271-4ec1-a4ef-88a649c60ba5');
  });

  it('공백 native session/call ID를 null로 정규화한다', () => {
    const content = [
      JSON.stringify({ sessionId: '  ', startTime: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({
        type: 'gemini', timestamp: '2026-07-20T00:00:01.000Z',
        toolCalls: [{ id: '\t', name: 'mcp_server_tool', status: 'success' }],
      }),
    ].join('\n');

    const parsed = geminiAdapter.parseFile('/fake/blank.jsonl', content);

    expect(parsed.session.externalSessionId).toBeNull();
    expect(parsed.toolCalls[0].externalCallId).toBeNull();
  });

  it('usage는 고유 gemini 레코드 수(2)만큼 — 스트리밍 중복 이중계상 방지', () => {
    expect(result.usage.length).toBe(2);
    const totalInput = result.usage.reduce((s, u) => s + u.inputTokens, 0);
    // 17861 + 18237 (중복 17861 재계상되면 35722 초과)
    expect(totalInput).toBe(36098);
    const totalCacheRead = result.usage.reduce((s, u) => s + u.cacheReadTokens, 0);
    expect(totalCacheRead).toBe(16201);
    expect(result.usage.every((u) => u.cacheCreationTokens === 0)).toBe(true);
  });

  it('usage 토큰 매핑 (input→inputTokens 등)', () => {
    const first = result.usage[0];
    expect(first.inputTokens).toBe(17861);
    expect(first.outputTokens).toBe(24);
    expect(first.cacheReadTokens).toBe(0);
  });

  it('한 레코드에 MCP 호출이 여럿이면 tokens.tool을 나눠 담는다 (합계 불변)', () => {
    const content = [
      JSON.stringify({ sessionId: 's-1', startTime: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({
        type: 'gemini',
        id: 'rec-1',
        timestamp: '2026-07-20T00:00:01.000Z',
        tokens: { input: 10, output: 5, cached: 0, tool: 100 },
        toolCalls: [
          { id: 'c1', name: 'mcp_alpha_one', status: 'success' },
          { id: 'c2', name: 'mcp_alpha_two', status: 'success' },
          { id: 'c3', name: 'mcp_alpha_three', status: 'success' },
        ],
      }),
    ].join('\n');

    const parsed = geminiAdapter.parseFile('/fake/multi.jsonl', content);

    expect(parsed.toolCalls.length).toBe(3);
    const total = parsed.toolCalls.reduce((s, t) => s + (t.responseTokens ?? 0), 0);
    // 곱셈 버그면 300이 된다
    expect(total).toBe(100);
    // 나머지는 앞쪽 호출에 1씩 더한다
    expect(parsed.toolCalls.map((t) => t.responseTokens)).toEqual([34, 33, 33]);
  });

  it('내장 툴이 섞여도 MCP 호출 수 기준으로만 분배한다', () => {
    const content = JSON.stringify({
      type: 'gemini',
      id: 'rec-2',
      timestamp: '2026-07-20T00:00:01.000Z',
      tokens: { tool: 7 },
      toolCalls: [
        { id: 'c1', name: 'read_file', status: 'success' },
        { id: 'c2', name: 'mcp_alpha_one', status: 'success' },
        { id: 'c3', name: 'mcp_alpha_two', status: 'success' },
      ],
    });

    const parsed = geminiAdapter.parseFile('/fake/mixed.jsonl', content);

    expect(parsed.toolCalls.map((t) => t.responseTokens)).toEqual([4, 3]);
  });

  it('tokens.tool이 없으면 responseTokens는 null', () => {
    const content = JSON.stringify({
      type: 'gemini',
      id: 'rec-3',
      timestamp: '2026-07-20T00:00:01.000Z',
      toolCalls: [
        { id: 'c1', name: 'mcp_alpha_one', status: 'success' },
        { id: 'c2', name: 'mcp_alpha_two', status: 'success' },
      ],
    });

    const parsed = geminiAdapter.parseFile('/fake/notokens.jsonl', content);

    expect(parsed.toolCalls.map((t) => t.responseTokens)).toEqual([null, null]);
  });

  it('중복 스트리밍 레코드가 있어도 분배가 두 번 적용되지 않는다', () => {
    const rec = {
      type: 'gemini',
      id: 'rec-4',
      timestamp: '2026-07-20T00:00:01.000Z',
      tokens: { tool: 9 },
      toolCalls: [
        { id: 'c1', name: 'mcp_alpha_one', status: 'success' },
        { id: 'c2', name: 'mcp_alpha_two', status: 'success' },
      ],
    };
    const parsed = geminiAdapter.parseFile(
      '/fake/dup.jsonl',
      [JSON.stringify(rec), JSON.stringify(rec)].join('\n'),
    );

    expect(parsed.toolCalls.length).toBe(2);
    expect(parsed.toolCalls.reduce((s, t) => s + (t.responseTokens ?? 0), 0)).toBe(9);
  });

  it('모든 이벤트 sessionId 일관', () => {
    const id = result.session.sessionId;
    expect(result.toolCalls.every((t) => t.sessionId === id)).toBe(true);
    expect(result.usage.every((u) => u.sessionId === id)).toBe(true);
  });
});
