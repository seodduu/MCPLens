import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { decodeClaudeHook } from '../../../src/ingest/clients/claude/decoder.js';
import { makeCorrelationKey, makeDeliveryId } from '../../../src/ingest/identity.js';

const fixture = (name: string): unknown => JSON.parse(
  readFileSync(new URL(`../../../../../fixtures/hooks/claude/${name}`, import.meta.url), 'utf8'),
);

const receivedAt = '2026-07-20T12:34:56.000Z';

describe('decodeClaudeHook', () => {
  test('normalizes an official SessionStart payload', () => {
    const result = decodeClaudeHook(fixture('session-start.json'), receivedAt);

    expect(result).toEqual({
      kind: 'observation',
      observation: expect.objectContaining({
        schemaVersion: 1,
        client: 'claude-code',
        phase: 'session-start',
        source: 'hook',
        receivedAt,
        observedAt: receivedAt,
        externalSessionId: 'claude-session-anon-001',
        externalTurnId: null,
        externalCallId: null,
        transcriptPath: '/tmp/claude/session-anon-001.jsonl',
        serverName: null,
        toolName: null,
        durationMs: null,
        isError: null,
        inputFingerprint: null,
        correlationConfidence: 'medium',
        responseTokens: null,
        loadedTokens: null,
      }),
    });
  });

  test('normalizes PostToolUse and preserves delimiters within the tool name', () => {
    const result = decodeClaudeHook(fixture('post-tool-use.json'), receivedAt);
    expect(result.kind).toBe('observation');
    if (result.kind !== 'observation') throw new Error('expected observation');

    const identity = {
      client: 'claude-code' as const,
      externalSessionId: 'claude-session-anon-001',
      externalTurnId: null,
      externalCallId: 'toolu_anon_success_001',
      phase: 'tool-after',
      toolName: 'search__issues',
      inputFingerprint: null,
    };
    expect(result.observation).toEqual({
      schemaVersion: 1,
      deliveryId: makeDeliveryId(identity),
      client: 'claude-code',
      phase: 'tool-after',
      receivedAt,
      externalSessionId: 'claude-session-anon-001',
      externalTurnId: null,
      externalCallId: 'toolu_anon_success_001',
      transcriptPath: '/tmp/claude/session-anon-001.jsonl',
      serverName: 'github',
      toolName: 'search__issues',
      observedAt: receivedAt,
      durationMs: 125.5,
      isError: false,
      inputFingerprint: null,
      source: 'hook',
      correlationKey: makeCorrelationKey(identity),
      correlationConfidence: 'high',
      responseTokens: null,
      loadedTokens: null,
    });
  });

  test('discards sensitive input, response, and unknown payload fields', () => {
    const payload = {
      ...(fixture('post-tool-use.json') as Record<string, unknown>),
      prompt: 'CLAUDE_PROMPT_SECRET_b205',
      unknown_secret: 'CLAUDE_UNKNOWN_SECRET_c36e',
    };
    const serialized = JSON.stringify(decodeClaudeHook(payload, receivedAt));

    expect(serialized).not.toContain('CLAUDE_TOOL_INPUT_SECRET_7f3d');
    expect(serialized).not.toContain('CLAUDE_TOOL_RESPONSE_SECRET_91ac');
    expect(serialized).not.toContain('CLAUDE_PROMPT_SECRET_b205');
    expect(serialized).not.toContain('CLAUDE_UNKNOWN_SECRET_c36e');
  });

  test('normalizes an official PostToolUseFailure payload as an error', () => {
    const result = decodeClaudeHook(fixture('post-tool-failure.json'), receivedAt);

    expect(result).toEqual({
      kind: 'observation',
      observation: expect.objectContaining({
        phase: 'tool-failure',
        serverName: 'postgres',
        toolName: 'query',
        externalCallId: 'toolu_anon_failure_001',
        durationMs: 42,
        isError: true,
        correlationConfidence: 'high',
      }),
    });
  });

  test.each([
    ['PreToolUse', 'tool-before'],
    ['SessionEnd', 'session-end'],
  ] as const)('maps %s to %s', (hookEventName, phase) => {
    const payload = hookEventName === 'PreToolUse'
      ? {
          session_id: 'session-no-native-call-id',
          transcript_path: null,
          hook_event_name: hookEventName,
          tool_name: 'mcp__filesystem__read_file',
          duration_ms: Number.POSITIVE_INFINITY,
        }
      : {
          session_id: 'session-no-native-call-id',
          transcript_path: null,
          hook_event_name: hookEventName,
        };

    const result = decodeClaudeHook(payload, receivedAt);
    expect(result).toEqual({
      kind: 'observation',
      observation: expect.objectContaining({
        phase,
        transcriptPath: null,
        durationMs: null,
        isError: null,
        correlationConfidence: 'medium',
      }),
    });
  });

  test.each([
    'Read',
    'mcp__github',
    'mcp____search',
    'mcp__github__',
    'mcp__   __query',
    'mcp__github__   ',
  ])('ignores non-MCP or malformed tool name %s', (toolName) => {
    expect(decodeClaudeHook({
      session_id: 'session-ignored-tool',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
    }, receivedAt)).toEqual({ kind: 'ignored', reason: 'non-mcp-tool' });
  });

  test('ignores unknown event names', () => {
    expect(decodeClaudeHook({
      session_id: 'session-unknown-event',
      hook_event_name: 'Notification',
    }, receivedAt)).toEqual({ kind: 'ignored', reason: 'unsupported-phase' });
  });

  test.each([undefined, null, '', '   '])('rejects missing or empty session_id %s', (sessionId) => {
    expect(decodeClaudeHook({
      session_id: sessionId,
      hook_event_name: 'SessionStart',
    }, receivedAt)).toEqual({ kind: 'invalid', code: 'missing-field' });
  });
});

describe('Claude plugin hook configuration', () => {
  test('registers session and MCP tool hooks through the bundled runner', () => {
    const config = fixture('../../../packages/lens-audit-plugin/hooks/hooks.json') as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };

    expect(Object.keys(config.hooks)).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'SessionEnd',
    ]);
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(config.hooks[event]?.[0]?.matcher).toBe('^mcp__.*');
    }
    for (const entries of Object.values(config.hooks)) {
      const command = entries[0]?.hooks[0]?.command;
      expect(command).toBe('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-runner.mjs"');
    }
  });
});
