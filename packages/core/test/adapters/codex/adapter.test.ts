import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CodexAdapter } from '../../../src/adapters/codex/adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/rollout-codemode.jsonl'), 'utf8');

describe('CodexAdapter', () => {
  const a = new CodexAdapter();

  it('matches는 .codex/sessions 밑 rollout-*.jsonl만 승인', () => {
    expect(a.matches('/h/.codex/sessions/2026-07-19/rollout-1.jsonl')).toBe(true);
    // 회귀: 실기기 레이아웃은 연/월/일 중첩 디렉토리
    expect(a.matches('/h/.codex/sessions/2026/07/19/rollout-1.jsonl')).toBe(true);
    expect(a.matches('/h/.claude/projects/x/y.jsonl')).toBe(false);
  });

  it('mcp_tool_call_end에서 server/tool/duration을 구조화 필드로 뽑는다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.toolCalls[0].serverName).toBeTruthy();
    expect(r.toolCalls[0].externalCallId).toBe('exec-1ae8218a-500d-48b9-9a3f-eb2d5a858173');
    expect(r.toolCalls[0].durationMs === null ||
           r.toolCalls[0].durationMs! >= 0).toBe(true);
  });

  it('session_meta의 native session ID를 externalSessionId로 보존한다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);

    expect(r.session.externalSessionId).toBe('019f762f-611f-73d3-9acb-d4875d9e42a7');
  });

  it('실제 task_started/turn_context payload의 turn_id를 호출 순서에 맞춰 보존한다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx) as ReturnType<CodexAdapter['parseFile']> & {
      toolCallTurnIds?: readonly (string | null)[];
    };

    expect(r.toolCallTurnIds).toEqual(['019f762f-617e-78f0-94e3-cde547506bf3']);
  });

  it('공백 native session/call ID를 null로 정규화한다', () => {
    const content = [
      JSON.stringify({ type: 'session_meta', payload: { type: 'session_meta', session_id: '  ', id: '\t' } }),
      JSON.stringify({
        timestamp: '2026-07-20T00:00:00.000Z', type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end', call_id: ' ',
          invocation: { server: 'server', tool: 'tool' }, result: { Ok: {} },
        },
      }),
    ].join('\n');

    const r = a.parseFile('/fake/blank.jsonl', content);

    expect(r.session.externalSessionId).toBeNull();
    expect(r.toolCalls[0].externalCallId).toBeNull();
  });

  it('Rust 스타일 result의 Err는 isError=true', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.toolCalls[0].isError).toBe(true);
  });

  it('코드 모드 검색 스크립트가 있으면 DEFERRED_MEASURABLE이고 loadedTokens가 직접 계산된다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.session.mode).toBe('DEFERRED_MEASURABLE');
    const withTokens = r.toolLoads.filter((l) => (l.loadedTokens ?? 0) > 0);
    expect(withTokens.length).toBeGreaterThan(0); // Codex는 원문 기록 → 직접 토크나이즈
  });

  it('token_count는 턴별 값으로 usage 적재 (누적 아님)', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.usage.length).toBeGreaterThan(0);
    // 턴별(last_token_usage) 값이어야 함 — 첫 이벤트 input_tokens=21928 (누적 total과 다름)
    expect(r.usage[0].inputTokens).toBe(21928);
    expect(r.usage[0].cacheReadTokens).toBe(9984);
  });

  it('깨진 줄은 parseErrors', () => {
    const r = a.parseFile('/fake/r.jsonl', '{broken\n' + fx);
    expect(r.parseErrors).toBe(1);
  });
});
