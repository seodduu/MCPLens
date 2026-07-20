import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCorrelationKey, makeDeliveryId } from '../../../src/ingest/identity.js';
import { decodeCodexHook } from '../../../src/ingest/clients/codex/decoder.js';

const NOW = '2026-07-20T12:00:00.000Z';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve('fixtures/hooks/codex', name), 'utf8'));
}

describe('decodeCodexHook', () => {
  it('normalizes an official-shape PostToolUse MCP event without retaining bodies', () => {
    const result = decodeCodexHook(fixture('post-tool-use.json'), NOW);

    expect(result).toMatchObject({
      kind: 'observation',
      observation: {
        schemaVersion: 1,
        client: 'codex',
        phase: 'tool-after',
        receivedAt: NOW,
        observedAt: NOW,
        externalSessionId: 'session-codex-1',
        externalTurnId: 'turn-codex-1',
        externalCallId: 'tool-codex-1',
        transcriptPath: null,
        serverName: 'github',
        toolName: 'get_issue',
        source: 'hook',
        correlationConfidence: 'high',
        durationMs: null,
        isError: null,
        inputFingerprint: null,
        responseTokens: null,
        loadedTokens: null,
      },
    });

    expect(result.kind).toBe('observation');
    if (result.kind !== 'observation') return;

    const identity = {
      client: 'codex' as const,
      externalSessionId: 'session-codex-1',
      externalTurnId: 'turn-codex-1',
      externalCallId: 'tool-codex-1',
      phase: 'tool-after',
      toolName: 'get_issue',
      inputFingerprint: null,
    };
    expect(result.observation.deliveryId).toBe(makeDeliveryId(identity));
    expect(result.observation.correlationKey).toBe(makeCorrelationKey(identity));

    const normalized = JSON.stringify(result);
    expect(normalized).not.toContain('sensitive-input-must-not-survive');
    expect(normalized).not.toContain('sensitive-response-must-not-survive');
    expect(normalized).not.toContain('tool_input');
    expect(normalized).not.toContain('tool_response');
  });

  it('accepts JSON text and tolerates model, permission mode, and unknown fields', () => {
    const input = {
      ...(fixture('post-tool-use.json') as Record<string, unknown>),
      model: 'future-model',
      permission_mode: 'future-mode',
      unknown_object: { prompt: 'do not retain me' },
      assistant_message: { content: 'do not retain me either' },
    };

    const result = decodeCodexHook(JSON.stringify(input), NOW);

    expect(result.kind).toBe('observation');
    expect(JSON.stringify(result)).not.toContain('do not retain me');
  });

  it('normalizes SessionStart as session-start evidence', () => {
    const result = decodeCodexHook(fixture('session-start.json'), NOW);

    expect(result).toMatchObject({
      kind: 'observation',
      observation: {
        phase: 'session-start',
        externalSessionId: 'session-codex-1',
        externalTurnId: null,
        externalCallId: null,
        transcriptPath: null,
        serverName: null,
        toolName: null,
        correlationConfidence: 'medium',
      },
    });
    if (result.kind !== 'observation') return;

    const identity = {
      client: 'codex' as const,
      externalSessionId: 'session-codex-1',
      externalTurnId: null,
      externalCallId: null,
      phase: 'session-start',
      toolName: null,
      inputFingerprint: null,
    };
    expect(result.observation.deliveryId).toBe(makeDeliveryId(identity));
    expect(result.observation.correlationKey).toBe(makeCorrelationKey(identity));
  });

  it('normalizes PreToolUse MCP evidence without counting a completed call', () => {
    const result = decodeCodexHook({
      session_id: 'session-codex-1',
      transcript_path: null,
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-codex-1',
      tool_name: 'mcp__github__get_issue',
      tool_use_id: 'tool-codex-1',
    }, NOW);

    expect(result).toMatchObject({
      kind: 'observation',
      observation: {
        phase: 'tool-before',
        externalSessionId: 'session-codex-1',
        externalTurnId: 'turn-codex-1',
        externalCallId: 'tool-codex-1',
        serverName: 'github',
        toolName: 'get_issue',
        correlationConfidence: 'high',
      },
    });
    if (result.kind !== 'observation') return;

    const identity = {
      client: 'codex' as const,
      externalSessionId: 'session-codex-1',
      externalTurnId: 'turn-codex-1',
      externalCallId: 'tool-codex-1',
      phase: 'tool-before',
      toolName: 'get_issue',
      inputFingerprint: null,
    };
    expect(result.observation.deliveryId).toBe(makeDeliveryId(identity));
    expect(result.observation.correlationKey).toBe(makeCorrelationKey(identity));
  });

  it('normalizes Stop as turn-stop evidence', () => {
    const result = decodeCodexHook({
      session_id: 'session-codex-1',
      transcript_path: null,
      hook_event_name: 'Stop',
      turn_id: 'turn-codex-1',
    }, NOW);

    expect(result).toMatchObject({
      kind: 'observation',
      observation: {
        phase: 'turn-stop',
        externalSessionId: 'session-codex-1',
        externalTurnId: 'turn-codex-1',
        externalCallId: null,
        serverName: null,
        toolName: null,
        correlationConfidence: 'medium',
      },
    });
    if (result.kind !== 'observation') return;

    const identity = {
      client: 'codex' as const,
      externalSessionId: 'session-codex-1',
      externalTurnId: 'turn-codex-1',
      externalCallId: null,
      phase: 'turn-stop',
      toolName: null,
      inputFingerprint: null,
    };
    expect(result.observation.deliveryId).toBe(makeDeliveryId(identity));
    expect(result.observation.correlationKey).toBe(makeCorrelationKey(identity));
  });

  it.each(['Bash', 'WebSearch', 'mcp__github__', 'mcp____get_issue', 'github__get_issue']) (
    'rejects non-MCP or malformed tool name %s',
    (toolName) => {
      expect(decodeCodexHook({
        session_id: 'session-codex-1',
        transcript_path: null,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-codex-1',
        tool_name: toolName,
        tool_use_id: 'tool-codex-1',
      }, NOW)).toEqual({ kind: 'ignored', reason: 'non-mcp-tool' });
    },
  );

  it.each([
    {},
    { hook_event_name: 'PostToolUse', session_id: '' },
    { hook_event_name: 'PostToolUse', session_id: 'session-codex-1', transcript_path: 42 },
    {
      hook_event_name: 'PostToolUse',
      session_id: 'session-codex-1',
      transcript_path: null,
      tool_name: 'mcp__github__get_issue',
      tool_use_id: 'tool-codex-1',
    },
  ])('returns a structured invalid result for missing or malformed required fields', (input) => {
    expect(decodeCodexHook(input, NOW)).toEqual({ kind: 'invalid', code: 'missing-field' });
  });

  it('returns invalid-json instead of throwing for malformed JSON input', () => {
    expect(decodeCodexHook('{not-json', NOW)).toEqual({ kind: 'invalid', code: 'invalid-json' });
  });

  it('rejects transcript paths containing an embedded NUL byte', () => {
    expect(decodeCodexHook({
      session_id: 'session-codex-1',
      transcript_path: '/tmp/codex\0transcript.jsonl',
      hook_event_name: 'SessionStart',
    }, NOW)).toEqual({ kind: 'invalid', code: 'unsafe-transcript-path' });
  });

  it('ignores unknown hook events', () => {
    expect(decodeCodexHook({
      session_id: 'session-codex-1',
      transcript_path: null,
      hook_event_name: 'FutureEvent',
    }, NOW)).toEqual({ kind: 'ignored', reason: 'unsupported-phase' });
  });
});
