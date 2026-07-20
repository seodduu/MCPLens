import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AdapterResult } from '../../src/types.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';
import { geminiAdapter } from '../../src/adapters/gemini/adapter.js';
import { adapterResultToObservations } from '../../src/ingest/log-bridge.js';
import { decodeClaudeHook } from '../../src/ingest/clients/claude/decoder.js';
import { decodeCodexHook } from '../../src/ingest/clients/codex/decoder.js';
import { decodeGeminiHook } from '../../src/ingest/clients/gemini/decoder.js';

const fixture = (...parts: string[]) => readFileSync(
  path.join(__dirname, '../../../../fixtures', ...parts), 'utf8',
);

const result: AdapterResult = {
  session: {
    sessionId: 'internal-session', client: 'codex', filePath: '/logs/session.jsonl',
    externalSessionId: 'external-session', startedAt: '2026-07-20T00:00:00.000Z', mode: 'DEFERRED_MEASURABLE',
  },
  toolCalls: [{
    sessionId: 'internal-session', serverName: 'github', toolName: 'get_issue',
    calledAt: '2026-07-20T00:00:01.000Z', durationMs: 12, isError: false,
    responseTokens: 34, responseText: 'sensitive response', externalCallId: 'native-call',
  }],
  toolLoads: [{
    sessionId: 'internal-session', serverName: 'github', toolName: 'get_issue', loadedTokens: 56,
  }],
  usage: [],
  parseErrors: 0,
};

describe('adapterResultToObservations', () => {
  it('로그 호출과 로드를 민감한 본문 없이 observation으로 변환한다', () => {
    const observations = adapterResultToObservations(result, []);

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      source: 'log', client: 'codex', phase: 'tool-after',
      externalSessionId: 'external-session', externalCallId: 'native-call',
      correlationConfidence: 'high', responseTokens: 34, loadedTokens: null,
    });
    expect(observations[1]).toMatchObject({
      source: 'log', phase: 'tool-before', externalCallId: null,
      correlationConfidence: 'low', responseTokens: null, loadedTokens: 56,
    });
    expect(JSON.stringify(observations)).not.toContain('sensitive response');
  });

  it('어댑터 ID가 없으면 nativeIds를 인덱스별로 사용한다', () => {
    const withoutId: AdapterResult = {
      ...result,
      toolCalls: [{ ...result.toolCalls[0], externalCallId: null }],
    };

    const [observation] = adapterResultToObservations(withoutId, ['supplied-native-id']);

    expect(observation.externalCallId).toBe('supplied-native-id');
    expect(observation.deliveryId).toMatch(/^native:/);
    expect(observation.correlationKey).toMatch(/^native:/);
    expect(observation.correlationConfidence).toBe('high');
  });

  it('native ID가 어느 경로에도 없으면 null과 low confidence를 유지한다', () => {
    const withoutId: AdapterResult = {
      ...result,
      toolCalls: [{ ...result.toolCalls[0], externalCallId: undefined }],
    };

    const [observation] = adapterResultToObservations(withoutId, []);

    expect(observation.externalCallId).toBeNull();
    expect(observation.deliveryId).toMatch(/^fallback:/);
    expect(observation.correlationConfidence).toBe('low');
  });

  it('공백 native ID를 null로 정규화하고 fallback identity를 사용한다', () => {
    const blankIds: AdapterResult = {
      ...result,
      session: { ...result.session, externalSessionId: '  ' },
      toolCalls: [{ ...result.toolCalls[0], externalCallId: '\t' }],
    };

    const [observation] = adapterResultToObservations(blankIds, ['  ']);

    expect(observation.externalSessionId).toBe('internal-session');
    expect(observation.externalCallId).toBeNull();
    expect(observation.deliveryId).toMatch(/^fallback:/);
    expect(observation.correlationKey).toMatch(/^fallback:/);
    expect(observation.correlationConfidence).toBe('low');
  });

  it('Claude fixture log와 Hook observation이 native identity로 상관된다', () => {
    const transcriptPath = '/fake/.claude/projects/project/session.jsonl';
    const parsed = new ClaudeAdapter().parseFile(
      transcriptPath, fixture('claude', 'session-toolsearch.jsonl'),
    );
    const logObservation = adapterResultToObservations(parsed, [])[0];
    const hook = decodeClaudeHook({
      hook_event_name: 'PostToolUse',
      session_id: parsed.session.externalSessionId,
      transcript_path: transcriptPath,
      tool_name: `mcp__${logObservation.serverName}__${logObservation.toolName}`,
      tool_use_id: logObservation.externalCallId,
    }, logObservation.observedAt);

    expect(hook.kind).toBe('observation');
    if (hook.kind !== 'observation') throw new Error('expected observation');
    expect(logObservation.correlationKey).toBe(hook.observation.correlationKey);
    expect(logObservation.correlationConfidence).toBe(hook.observation.correlationConfidence);
  });

  it('Gemini fixture log와 Hook observation이 native delivery를 보존하면서 fallback identity로 상관된다', () => {
    const transcriptPath = '/fake/.gemini/tmp/project/chats/session.jsonl';
    const parsed = geminiAdapter.parseFile(
      transcriptPath, fixture('gemini', 'chat-upfront.jsonl'),
    );
    const logObservation = adapterResultToObservations(parsed, [])[0];
    const hook = decodeGeminiHook({
      hook_event_name: 'AfterTool',
      session_id: parsed.session.externalSessionId,
      timestamp: logObservation.observedAt,
      transcript_path: transcriptPath,
      tool_name: 'mcp_lenstest_lens_get_weather',
      tool_input: { query: 'Seoul' },
      tool_response: { output: 'redacted' },
    }, logObservation.observedAt);

    expect(hook.kind).toBe('observation');
    if (hook.kind !== 'observation') throw new Error('expected observation');
    expect(logObservation.externalCallId).toBe('mcp_lenstest_lens_get_weather__1jlcieln');
    expect(logObservation.deliveryId).toMatch(/^native:/);
    expect(logObservation.correlationKey).toBe(hook.observation.correlationKey);
    expect(logObservation.correlationConfidence).toBe(hook.observation.correlationConfidence);
  });

  it('Codex 실제 rollout·Hook fixture가 turn/session/call native identity로 상관된다', () => {
    const transcriptPath = '/fake/.codex/sessions/2026/07/18/rollout-session.jsonl';
    const parsed = new CodexAdapter().parseFile(
      transcriptPath,
      fixture('codex', 'rollout-codemode.jsonl'),
    );
    const [logObservation] = adapterResultToObservations(parsed, []);
    const hookFixture = JSON.parse(fixture('hooks', 'codex', 'post-tool-use.json'));
    const hook = decodeCodexHook({
      ...hookFixture,
      session_id: logObservation.externalSessionId,
      transcript_path: transcriptPath,
      turn_id: logObservation.externalTurnId,
      tool_name: `mcp__${logObservation.serverName}__${logObservation.toolName}`,
      tool_use_id: logObservation.externalCallId,
    }, logObservation.observedAt);

    expect(hook.kind).toBe('observation');
    if (hook.kind !== 'observation') throw new Error('expected observation');
    expect(logObservation.externalSessionId).toBe('019f762f-611f-73d3-9acb-d4875d9e42a7');
    expect(logObservation.externalTurnId).toBe('019f762f-617e-78f0-94e3-cde547506bf3');
    expect(logObservation.externalCallId).toBe('exec-1ae8218a-500d-48b9-9a3f-eb2d5a858173');
    expect(logObservation.correlationKey).toBe(hook.observation.correlationKey);
  });

  it('Gemini 동일 tool 반복 호출은 native delivery 카디널리티와 H4 fallback correlation을 함께 보존한다', () => {
    const parsed = geminiAdapter.parseFile('/fake/repeated.jsonl', [
      JSON.stringify({ sessionId: 'gemini-session', startTime: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({
        type: 'gemini', id: 'message-1', timestamp: '2026-07-20T00:00:01.000Z',
        toolCalls: [{ id: 'native-1', name: 'mcp_server_same_tool', status: 'success' }],
      }),
      JSON.stringify({
        type: 'gemini', id: 'message-2', timestamp: '2026-07-20T00:00:02.000Z',
        toolCalls: [{ id: 'native-2', name: 'mcp_server_same_tool', status: 'success' }],
      }),
    ].join('\n'));

    const observations = adapterResultToObservations(parsed, []);

    expect(observations).toHaveLength(2);
    expect(observations.map((item) => item.externalCallId)).toEqual(['native-1', 'native-2']);
    expect(new Set(observations.map((item) => item.deliveryId)).size).toBe(2);
    expect(observations.every((item) => item.deliveryId.startsWith('native:'))).toBe(true);
    expect(observations.map((item) => item.correlationConfidence)).toEqual(['low', 'low']);
    // H4 AfterTool은 privacy-safe call/occurrence ID를 보존하지 않아 H0 identity로는
    // 동일 세션·툴·phase 반복 호출을 서로 다른 cross-source key로 표현할 수 없다.
    expect(new Set(observations.map((item) => item.correlationKey)).size).toBe(1);
    expect(JSON.stringify(observations)).not.toContain('toolCalls');
  });
});
