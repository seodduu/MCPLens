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

// Expected tokens come from the raw fixture, not from the numbers in the plan. The fixture is the truth.
const multiDefinitions: unknown[] = JSON.parse(
  JSON.parse(multiFx.trim().split('\n').at(-1)!).payload.output.at(-1).text as string,
);

describe('CodexAdapter', () => {
  const a = new CodexAdapter();

  it('matches only rollout-*.jsonl under .codex/sessions', () => {
    expect(a.matches('/h/.codex/sessions/2026-07-19/rollout-1.jsonl')).toBe(true);
    // Regression: the real-device layout uses nested year/month/day directories
    expect(a.matches('/h/.codex/sessions/2026/07/19/rollout-1.jsonl')).toBe(true);
    expect(a.matches('/h/.claude/projects/x/y.jsonl')).toBe(false);
  });

  it('extracts server, tool and duration from mcp_tool_call_end as structured fields', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.toolCalls[0].serverName).toBeTruthy();
    expect(r.toolCalls[0].externalCallId).toBe('exec-1ae8218a-500d-48b9-9a3f-eb2d5a858173');
    expect(r.toolCalls[0].durationMs === null ||
           r.toolCalls[0].durationMs! >= 0).toBe(true);
  });

  it('counts responseText with tiktoken, since there is no measured response token count', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    const call = r.toolCalls[0];

    expect(call.responseText).toBeTruthy();
    expect(call.responseTokens).toBe(countTokens(call.responseText!));
    expect(call.responseTokens).toBeGreaterThan(0);
  });

  it('leaves responseTokens null when there is no response body', () => {
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

  it('preserves the native session ID from session_meta as externalSessionId', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);

    expect(r.session.externalSessionId).toBe('019f762f-611f-73d3-9acb-d4875d9e42a7');
  });

  it('preserves turn_id from real task_started/turn_context payloads in call order', () => {
    const r = a.parseFile('/fake/r.jsonl', fx) as ReturnType<CodexAdapter['parseFile']> & {
      toolCallTurnIds?: readonly (string | null)[];
    };

    expect(r.toolCallTurnIds).toEqual(['019f762f-617e-78f0-94e3-cde547506bf3']);
  });

  it('normalizes blank native session/call IDs to null', () => {
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

  it('marks a Rust-style result Err as isError=true', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.toolCalls[0].isError).toBe(true);
  });

  it('reports DEFERRED_MEASURABLE with directly computed loadedTokens when a code-mode search script is present', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.session.mode).toBe('DEFERRED_MEASURABLE');
    const withTokens = r.toolLoads.filter((l) => (l.loadedTokens ?? 0) > 0);
    expect(withTokens.length).toBeGreaterThan(0); // Codex records the raw text, so it is tokenized directly
  });

  it('ingests token_count as the per-turn value, not the cumulative one', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.usage.length).toBeGreaterThan(0);
    // It must be the per-turn (last_token_usage) value: the first event has input_tokens=21928, different from the cumulative total
    expect(r.usage[0].inputTokens).toBe(21928);
    expect(r.usage[0].cacheReadTokens).toBe(9984);
  });

  it('counts a broken line as a parseError', () => {
    const r = a.parseFile('/fake/r.jsonl', '{broken\n' + fx);
    expect(r.parseErrors).toBe(1);
  });

  it('creates no canonical ToolSearchAttempt from the legacy exact-name fixture', () => {
    const r = a.parseFile('/fake/tool-search-no-match.jsonl', noMatchFx);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('does not treat TOOL_NOT_FOUND in the script as a failed search when the real output is user-cancelled', () => {
    const r = a.parseFile('/fake/tool-search-cancelled.jsonl', cancelledFx);

    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('keeps only the exposed tool name and token count from an exact single-definition output', () => {
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

  it('fails closed to a generic load for cancelled, malformed and duplicate exact outputs', () => {
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

  it('leaves a broad output returning several definitions as a generic load, even for exact input', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad', output: '[{"name":"mcp__atlas__lookup"},{"name":"mcp__atlas__other"}]' } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad.jsonl', content).toolLoads).toMatchObject([{
      toolName: '(code-mode-search)',
    }]);
  });

  it('leaves a broad name search as a generic load even when it returns a single canonical definition', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-input', input: 'ALL_TOOLS.filter(x => x.name.includes("mcp__atlas__lookup"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-input', output: '[{"name":"mcp__atlas__lookup"}]' } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad-input.jsonl', content).toolLoads).toMatchObject([{
      toolName: '(code-mode-search)',
    }]);
  });

  it('creates no ToolSearchAttempt for a canonical .includes no-match', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-no-match', input: 'ALL_TOOLS.filter(x => x.name.includes("mcp__atlas__lookup"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-no-match', output: 'TOOL_NOT_FOUND' } }),
    ].join('\n');

    const r = a.parseFile('/fake/broad-no-match.jsonl', content);
    expect(r.toolLoads).toMatchObject([{ toolName: '(code-mode-search)' }]);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('creates a ToolSearchAttempt for a canonical literal-equality no-match', () => {
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

  it('does not treat fake comparisons in comments or strings, or a nested metadata name, as an exact success', () => {
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

  it('rejects a name-only definition and accepts a real definition whose description mentions error or cancelled', () => {
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

  it('records only a multipart empty array as a structural no-match and rejects sentinel mixtures', () => {
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

  it('fails closed when arbitrary prose or an unsupported block is mixed into a definition or sentinel', () => {
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

  it('treats abnormal metadata and an empty transport array as neither success nor no-match', () => {
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

  it('requires the evidence to be a single block after the metadata and rejects order or duplicate mixtures', () => {
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

  it('does not let an unterminated block comment leak a hidden literal into the exact search target', () => {
    const input = 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup") /* unterminated';
    // maskJavaScript gives up safely, so extractExactCanonicalSearch is still null: the guard that
    // keeps a literal hidden in a comment from posing as "this exact name was searched" stays intact.
    // A recognition failure (null) is now the same signal as a broad search, though, so an output
    // holding one intact definition is judged a success under that definition's own name (the intended
    // behaviour of change 3). A no-match is recorded only when we know what was being looked for, so in
    // the recognition-failure state a TOOL_NOT_FOUND is still generic and leaves no toolSearchAttempts.
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

  it('extracts the exposed tool name when a broad search returns one intact definition', () => {
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

  it('leaves a broad search returning a non-canonical name as generic', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-noncanonical', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-noncanonical', output: [{ type: 'input_text', text: '[{"name":"atlas-lookup","description":"Look up a record"}]' }] } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad-noncanonical.jsonl', content).toolLoads)
      .toMatchObject([{ toolName: '(code-mode-search)' }]);
  });

  it('records each of the N definitions in a substring search output as a load', () => {
    const r = a.parseFile('/fake/tool-search-multi.jsonl', multiFx);

    expect(r.toolLoads).toHaveLength(2);
    expect(r.toolLoads.map((l) => l.toolName).sort())
      .toEqual(['mcp__atlas__lookup', 'mcp__atlas__search']);
    expect(r.toolLoads.every((l) => l.serverName === null)).toBe(true);
    expect(r.toolLoads.filter((l) => l.toolName === '(code-mode-search)')).toHaveLength(0);
  });

  it('splits the tokens of a multi-load by the size of each definition', () => {
    const r = a.parseFile('/fake/tool-search-multi.jsonl', multiFx);
    const byName = new Map(r.toolLoads.map((l) => [l.toolName, l.loadedTokens]));

    const [lookupDefinition, searchDefinition] = multiDefinitions;
    expect(byName.get('mcp__atlas__lookup'))
      .toBe(countTokens(JSON.stringify(lookupDefinition)));
    expect(byName.get('mcp__atlas__search'))
      .toBe(countTokens(JSON.stringify(searchDefinition)));
    // Pins that it is not an even split.
    expect(byName.get('mcp__atlas__lookup')).not.toBe(byName.get('mcp__atlas__search'));
  });

  it('does not count non-canonical elements as loads', () => {
    const r = a.parseFile('/fake/tool-search-multi-mixed.jsonl', multiMixedFx);

    expect(r.toolLoads).toHaveLength(2);
    expect(r.toolLoads.map((l) => l.toolName).sort())
      .toEqual(['mcp__atlas__lookup', 'mcp__atlas__search']);
    expect(r.toolLoads.some((l) => l.toolName === 'exec')).toBe(false);
  });

  it('leaves it as an aggregate row when there is no canonical definition at all', () => {
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

  it('keeps an exact search generic when it has two or more elements', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'exact-multi', input: 'ALL_TOOLS.filter(x => x.name === "mcp__atlas__lookup")' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'exact-multi', output: '[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__search","description":"b"}]' } }),
    ].join('\n');

    const r = a.parseFile('/fake/exact-multi.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
  });

  it('counts an output carrying the same tool twice only once', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'dup', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'dup', output: '[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__lookup","description":"a"}]' } }),
    ].join('\n');

    const r = a.parseFile('/fake/dup.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('mcp__atlas__lookup');
  });

  it('keeps an object-wrapper output generic', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'wrapper', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'wrapper', output: '{"matches":[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__search","description":"b"}]}' } }),
    ].join('\n');

    const r = a.parseFile('/fake/wrapper.jsonl', content);

    expect(r.toolLoads).toHaveLength(1);
    expect(r.toolLoads[0]?.toolName).toBe('(code-mode-search)');
  });

  it('keeps a truncated output generic', () => {
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
