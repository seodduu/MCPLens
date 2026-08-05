import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CodexAdapter } from '../../../src/adapters/codex/adapter.js';
import { countTokens } from '../../../src/tokenize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/rollout-codemode.jsonl'), 'utf8');
const noMatchFx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/tool-search-no-match.jsonl'), 'utf8');
const cancelledFx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/tool-search-cancelled.jsonl'), 'utf8');
const successFx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/tool-search-success.jsonl'), 'utf8');
const multiFx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/tool-search-multi.jsonl'), 'utf8');
const multiMixedFx = readFileSync(
  path.join(here, '../../../../../fixtures/codex/tool-search-multi-mixed.jsonl'), 'utf8');

// 기대 토큰은 계획서 수치가 아니라 픽스처 원문에서 뽑는다. 픽스처가 진실이다.
const multiDefinitions: unknown[] = JSON.parse(
  JSON.parse(multiFx.trim().split('\n').at(-1)!).payload.output.at(-1).text as string,
);

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

  it('실측 응답 토큰이 없으므로 responseText를 tiktoken으로 계상한다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    const call = r.toolCalls[0];

    expect(call.responseText).toBeTruthy();
    expect(call.responseTokens).toBe(countTokens(call.responseText!));
    expect(call.responseTokens).toBeGreaterThan(0);
  });

  it('응답 본문이 없으면 responseTokens는 null', () => {
    const line = JSON.stringify({
      timestamp: '2026-07-20T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'c1',
        invocation: { server: 'alpha', tool: 'one' },
      },
    });

    const r = a.parseFile('/fake/empty.jsonl', line);

    expect(r.toolCalls[0].responseText).toBeNull();
    expect(r.toolCalls[0].responseTokens).toBeNull();
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

  it('legacy exact-name fixture는 canonical ToolSearchAttempt를 만들지 않는다', () => {
    const r = a.parseFile('/fake/tool-search-no-match.jsonl', noMatchFx);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('스크립트에 TOOL_NOT_FOUND가 있어도 실제 output이 user-cancelled이면 검색 실패로 보지 않는다', () => {
    const r = a.parseFile('/fake/tool-search-cancelled.jsonl', cancelledFx);

    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('정확한 단일 정의 output은 exposed tool name과 토큰 수만 보존한다', () => {
    const r = a.parseFile('/fake/tool-search-success.jsonl', successFx);

    expect(r.toolLoads).toEqual([{
      sessionId: r.session.sessionId,
      serverName: null,
      toolName: 'mcp__atlas__lookup',
      loadedTokens: expect.any(Number),
    }]);
    expect(r.toolLoads[0]?.loadedTokens).toBeGreaterThan(0);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('anonymous definition');
  });

  it('취소·malformed·중복 exact output은 generic load로 fail-closed한다', () => {
    const cases = [
      cancelledFx,
      [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'malformed', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'malformed', output: '{not-json' } }),
      ].join('\n'),
      [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'ambiguous', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'ambiguous', output: '[{"name":"mcp__atlas__lookup"},{"name":"mcp__atlas__lookup"}]' } }),
      ].join('\n'),
    ];

    for (const content of cases) {
      const r = a.parseFile('/fake/fail-closed.jsonl', content);
      expect(r.toolLoads.every(
        (load) => load.toolName === '(code-mode-search)',
      )).toBe(true);
      expect(r.toolSearchAttempts ?? []).toEqual([]);
    }
  });

  it('정확한 입력이어도 여러 정의를 반환한 broad output은 generic load로 남긴다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad', output: '[{"name":"mcp__atlas__lookup"},{"name":"mcp__atlas__other"}]' } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad.jsonl', content).toolLoads).toMatchObject([{
      toolName: '(code-mode-search)',
    }]);
  });

  it('broad name search는 단일 canonical definition을 반환해도 generic load로 남긴다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-input', input: 'ALL_TOOLS.filter(x => x.name.includes("mcp__atlas__lookup"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-input', output: '[{"name":"mcp__atlas__lookup"}]' } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad-input.jsonl', content).toolLoads).toMatchObject([{
      toolName: '(code-mode-search)',
    }]);
  });

  it('canonical .includes no-match는 ToolSearchAttempt를 만들지 않는다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-no-match', input: 'ALL_TOOLS.filter(x => x.name.includes("mcp__atlas__lookup"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-no-match', output: 'TOOL_NOT_FOUND' } }),
    ].join('\n');

    const r = a.parseFile('/fake/broad-no-match.jsonl', content);
    expect(r.toolLoads).toMatchObject([{ toolName: '(code-mode-search)' }]);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('canonical literal equality no-match는 ToolSearchAttempt를 만든다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'exact-no-match', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ timestamp: '2026-07-20T00:30:01.000Z', payload: { type: 'custom_tool_call_output', call_id: 'exact-no-match', output: 'TOOL_NOT_FOUND' } }),
    ].join('\n');

    const r = a.parseFile('/fake/exact-no-match.jsonl', content);
    expect(r.toolSearchAttempts).toEqual([{
      sessionId: r.session.sessionId, exactToolName: 'mcp__atlas__lookup',
      observedAt: '2026-07-20T00:30:01.000Z', noMatch: true,
    }]);
  });

  it('주석·문자열의 fake comparison과 nested metadata name은 exact success가 아니다', () => {
    const inputs = [
      'ALL_TOOLS; // ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")',
      'ALL_TOOLS; /* ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup") */',
      'const fake = "ALL_TOOLS.filter(x => x.name === \\"mcp__atlas__lookup\\")"; ALL_TOOLS;',
      "const fake = 'ALL_TOOLS.filter(x => x.name === \\\"mcp__atlas__lookup\\\")'; ALL_TOOLS;",
      'const fake = `ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")`; ALL_TOOLS;',
      'const fake = /ALL_TOOLS\\.filter\\(x => x\\.name === "mcp__atlas__lookup"\\)/; ALL_TOOLS;',
      'const fake = /[/]ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")/; ALL_TOOLS;',
    ];
    for (const input of inputs) {
      const content = [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'fake', input } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'fake', output: '[{"name":"mcp__atlas__lookup"}]' } }),
      ].join('\n');
      expect(a.parseFile('/fake/fake-input.jsonl', content).toolLoads[0]?.toolName)
        .toBe('(code-mode-search)');
    }
    const nested = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'nested', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'nested', output: '{"metadata":{"name":"mcp__atlas__lookup"}}' } }),
    ].join('\n');
    expect(a.parseFile('/fake/nested.jsonl', nested).toolLoads[0]?.toolName).toBe('(code-mode-search)');
  });

  it('name-only definition은 거부하고 description의 error/cancelled 문구가 있는 실제 definition은 허용한다', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")';
    const cases: Array<[unknown, string]> = [
      ['[{"name":"mcp__atlas__lookup"}]', '(code-mode-search)'],
      ['[{"name":"mcp__atlas__lookup","description":"error cancelled label"}]', 'mcp__atlas__lookup'],
      ['[{"name":"mcp__atlas__lookup","inputSchema":null}]', '(code-mode-search)'],
      ['[{"name":"mcp__atlas__lookup","inputSchema":"not-an-object"}]', '(code-mode-search)'],
      ['[{"name":"mcp__atlas__lookup","inputSchema":1}]', '(code-mode-search)'],
      ['[{"name":"mcp__atlas__lookup","inputSchema":{}}]', 'mcp__atlas__lookup'],
    ];
    for (const [output, expectedToolName] of cases) {
      const content = [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'definition-shape', input } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'definition-shape', output } }),
      ].join('\n');
      expect(a.parseFile('/fake/definition-shape.jsonl', content).toolLoads[0]?.toolName)
        .toBe(expectedToolName);
    }
  });

  it('multipart empty array만 구조적 no-match로 기록하고 sentinel 혼합물은 거부한다', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")';
    const cases: Array<[unknown, boolean]> = [
      [[{ type: 'input_text', text: 'Output:' }, { type: 'input_text', text: '[]' }], true],
      ['sentinel mentioned: TOOL_NOT_FOUND', false],
      [[{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: '{bad-json' }], false],
      [[{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: '[{"name":"mcp__atlas__lookup"},{"name":"mcp__atlas__other"}]' }], false],
      [[{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: 'user cancelled with error' }], false],
    ];
    for (const [output, expectedAttempt] of cases) {
      const content = [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'classified', input } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'classified', output } }),
      ].join('\n');
      const r = a.parseFile('/fake/classified.jsonl', content);
      expect(r.toolSearchAttempts?.length ?? 0).toBe(expectedAttempt ? 1 : 0);
      expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
    }
  });

  it('definition 또는 sentinel에 임의 prose·미지원 block이 섞이면 fail-closed한다', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")';
    const cases: unknown[] = [
      [{ type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"anonymous"}]' }, { type: 'input_text', text: 'unrelated prose' }],
      [{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: 'unrelated prose' }],
      [{ type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"anonymous"}]' }, { type: 'image' }],
      [{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'image' }],
    ];
    for (const output of cases) {
      const content = [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'mixed', input } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'mixed', output } }),
      ].join('\n');
      const r = a.parseFile('/fake/mixed-output.jsonl', content);
      expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
      expect(r.toolSearchAttempts ?? []).toEqual([]);
    }
  });

  it('비정상 metadata와 빈 transport array는 success/no-match가 아니다', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")';
    const cases: unknown[] = [
      [{ type: 'input_text', text: 'Output: unrelated prose' }, { type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"anonymous"}]' }],
      [{ type: 'input_text', text: 'Script completed unrelated prose' }, { type: 'input_text', text: 'TOOL_NOT_FOUND' }],
      [{ type: 'input_text', text: 'Process exited with code 1' }, { type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"anonymous"}]' }],
      [{ type: 'input_text', text: 'Process exited with code 1' }, { type: 'input_text', text: 'TOOL_NOT_FOUND' }],
      [],
    ];
    for (const output of cases) {
      const content = [
        JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'bad-metadata', input } }),
        JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'bad-metadata', output } }),
      ].join('\n');
      const r = a.parseFile('/fake/bad-metadata.jsonl', content);
      expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
      expect(r.toolSearchAttempts ?? []).toEqual([]);
    }
  });

  it('증거는 metadata 뒤의 단일 block 하나여야 하며 순서·중복 혼합을 거부한다', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")';
    const accepted = [
      { type: 'input_text', text: 'Script completed\nOutput:\nTOOL_NOT_FOUND' },
    ];
    const rejected: unknown[] = [
      [{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: 'TOOL_NOT_FOUND' }],
      [{ type: 'input_text', text: '[]' }, { type: 'input_text', text: '[]' }],
      [{ type: 'input_text', text: 'TOOL_NOT_FOUND' }, { type: 'input_text', text: 'Output:' }],
      [{ type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"anonymous"}]' }, { type: 'input_text', text: 'Output:' }],
    ];
    const parse = (output: unknown) => a.parseFile('/fake/evidence-order.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'evidence-order', input } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'evidence-order', output } }),
    ].join('\n'));

    expect(parse(accepted).toolSearchAttempts).toHaveLength(1);
    for (const output of rejected) {
      const r = parse(output);
      expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
      expect(r.toolSearchAttempts ?? []).toEqual([]);
    }
  });

  it('unterminated block comment는 숨은 리터럴을 exact 검색 대상으로 새어나가게 하지 않는다', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup") /* unterminated';
    // maskJavaScript가 안전하게 포기하므로 extractExactCanonicalSearch는 여전히 null이다 —
    // 코멘트에 숨은 리터럴이 "이 이름을 정확히 검색했다"는 신뢰로 둔갑하지 않는다는 방어는
    // 그대로 유지된다. 다만 인식 실패(null)는 이제 "넓은 검색"과 같은 신호이므로, 출력이
    // 온전한 단일 정의면 그 정의 자체의 이름으로 성공 판정된다(변경 3의 의도된 동작).
    // no-match는 "무엇을 찾다가 없었는지" 아는 경우만 기록하므로, 인식 실패 상태에서는
    // TOOL_NOT_FOUND가 와도 여전히 generic이고 toolSearchAttempts에 남지 않는다.
    const success = a.parseFile('/fake/unterminated-comment-success.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'unterminated', input } }),
      JSON.stringify({
        payload: {
          type: 'custom_tool_call_output', call_id: 'unterminated',
          output: '[{"name":"mcp__atlas__lookup","description":"anonymous"}]',
        },
      }),
    ].join('\n'));
    expect(success.toolLoads[0]?.toolName).toBe('mcp__atlas__lookup');
    expect(success.toolSearchAttempts ?? []).toEqual([]);

    const noMatch = a.parseFile('/fake/unterminated-comment-no-match.jsonl', [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'unterminated', input } }),
      JSON.stringify({
        payload: { type: 'custom_tool_call_output', call_id: 'unterminated', output: 'TOOL_NOT_FOUND' },
      }),
    ].join('\n'));
    expect(noMatch.toolLoads[0]?.toolName).toBe('(code-mode-search)');
    expect(noMatch.toolSearchAttempts ?? []).toEqual([]);
  });

  it('넓은 조건 검색이어도 온전한 단일 정의를 반환하면 exposed tool name을 뽑는다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-exact', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-exact', output: [{ type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"Look up a record"}]' }] } }),
    ].join('\n');

    const r = a.parseFile('/fake/broad-exact.jsonl', content);

    expect(r.toolLoads).toEqual([{
      sessionId: r.session.sessionId, serverName: null,
      toolName: 'mcp__atlas__lookup', loadedTokens: expect.any(Number),
    }]);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('넓은 조건 검색이 canonical 형태가 아닌 이름을 반환하면 generic으로 남긴다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-noncanonical', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-noncanonical', output: [{ type: 'input_text', text: '[{"name":"atlas-lookup","description":"Look up a record"}]' }] } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad-noncanonical.jsonl', content).toolLoads)
      .toMatchObject([{ toolName: '(code-mode-search)' }]);
  });

  it('부분일치 검색 출력의 정의 N개를 각각 로드로 기록한다', () => {
    const r = a.parseFile('/fake/tool-search-multi.jsonl', multiFx);

    expect(r.toolLoads).toHaveLength(2);
    expect(r.toolLoads.map((l) => l.toolName).sort())
      .toEqual(['mcp__atlas__lookup', 'mcp__atlas__search']);
    expect(r.toolLoads.every((l) => l.serverName === null)).toBe(true);
    expect(r.toolLoads.filter((l) => l.toolName === '(code-mode-search)')).toHaveLength(0);
  });

  it('다중 로드의 토큰은 원소별 정의 크기로 나뉜다', () => {
    const r = a.parseFile('/fake/tool-search-multi.jsonl', multiFx);
    const byName = new Map(r.toolLoads.map((l) => [l.toolName, l.loadedTokens]));

    const [lookupDefinition, searchDefinition] = multiDefinitions;
    expect(byName.get('mcp__atlas__lookup'))
      .toBe(countTokens(JSON.stringify(lookupDefinition)));
    expect(byName.get('mcp__atlas__search'))
      .toBe(countTokens(JSON.stringify(searchDefinition)));
    // 균등 배분이 아님을 고정한다.
    expect(byName.get('mcp__atlas__lookup')).not.toBe(byName.get('mcp__atlas__search'));
  });

  it('canonical이 아닌 원소는 로드로 세지 않는다', () => {
    const r = a.parseFile('/fake/tool-search-multi-mixed.jsonl', multiMixedFx);

    expect(r.toolLoads).toHaveLength(2);
    expect(r.toolLoads.map((l) => l.toolName).sort())
      .toEqual(['mcp__atlas__lookup', 'mcp__atlas__search']);
    expect(r.toolLoads.some((l) => l.toolName === 'exec')).toBe(false);
  });

  it('canonical 정의가 하나도 없으면 집계 행으로 남는다', () => {
    const output = '[{"name":"exec","description":"Run a shell command."},'
      + '{"name":"apply_patch","description":"Apply a patch."}]';
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'builtin-only', input: 'ALL_TOOLS.filter(x => x.name.includes("a"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'builtin-only', output } }),
    ].join('\n');

    const r = a.parseFile('/fake/builtin-only.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
    expect(r.toolLoads[0]?.loadedTokens).toBe(countTokens(output));
  });

  it('정확 검색은 원소가 2개 이상이면 여전히 generic이다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'exact-multi', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'exact-multi', output: '[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__search","description":"b"}]' } }),
    ].join('\n');

    const r = a.parseFile('/fake/exact-multi.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
  });

  it('같은 툴이 중복 실린 출력은 한 번만 센다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'dup', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'dup', output: '[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__lookup","description":"a"}]' } }),
    ].join('\n');

    const r = a.parseFile('/fake/dup.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('mcp__atlas__lookup');
  });

  it('객체 래퍼 출력은 계속 generic이다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'wrapper', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'wrapper', output: '{"matches":[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__search","description":"b"}]}' } }),
    ].join('\n');

    const r = a.parseFile('/fake/wrapper.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
  });

  it('잘린 출력은 계속 generic이다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'truncated', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({
        payload: {
          type: 'custom_tool_call_output', call_id: 'truncated',
          output: [
            { type: 'input_text', text: 'Warning: truncated output' },
            { type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__search","description":"b"}]' },
          ],
        },
      }),
    ].join('\n');

    const r = a.parseFile('/fake/truncated.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
  });
});
