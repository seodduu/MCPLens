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
  it('converts log calls and loads into observations with no sensitive body', () => {
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

  it('uses nativeIds by index when the adapter has no IDs', () => {
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

  it('keeps null and low confidence when the native ID is on no path at all', () => {
    const withoutId: AdapterResult = {
      ...result,
      toolCalls: [{ ...result.toolCalls[0], externalCallId: undefined }],
    };

    const [observation] = adapterResultToObservations(withoutId, []);

    expect(observation.externalCallId).toBeNull();
    expect(observation.deliveryId).toMatch(/^fallback:/);
    expect(observation.correlationConfidence).toBe('low');
  });

  it('normalizes a blank native ID to null and uses the fallback identity', () => {
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

  it('correlates a Claude fixture log with a hook observation through the native identity', () => {
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

  it('correlates a Gemini fixture log through the fallback identity while preserving the native delivery', () => {
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

  it('correlates a real Codex rollout with hook fixtures through the turn/session/call native identity', () => {
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

  it('preserves both the native delivery cardinality and the H4 fallback correlation for repeated Gemini calls to the same tool', () => {
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
    // H4 AfterTool does not preserve a privacy-safe call/occurrence ID, so the H0 identity cannot
    // express repeated calls in the same session, tool and phase as distinct cross-source keys.
    expect(new Set(observations.map((item) => item.correlationKey)).size).toBe(1);
    expect(JSON.stringify(observations)).not.toContain('toolCalls');
  });
});
