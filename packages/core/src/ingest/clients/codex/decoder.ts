import type {
  HookDecoder,
  HookEnvelope,
  HookNormalizationResult,
} from '../../contracts.js';
import { makeCorrelationKey, makeDeliveryId } from '../../identity.js';

type JsonObject = Record<string, unknown>;

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

type ParsedInput =
  | { ok: true; value: JsonObject }
  | { ok: false; result: HookNormalizationResult };

function objectInput(input: unknown): ParsedInput {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, result: { kind: 'invalid', code: 'invalid-json' } };
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, result: { kind: 'invalid', code: 'missing-field' } };
  }
  return { ok: true, value: parsed as JsonObject };
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function invalid(code: 'missing-field' | 'unsafe-transcript-path'): HookNormalizationResult {
  return { kind: 'invalid', code };
}

export const decodeCodexHook: HookDecoder = (input, receivedAt) => {
  const parsed = objectInput(input);
  if (!parsed.ok) return parsed.result;
  const payload = parsed.value;

  if (!requiredString(payload.hook_event_name) || !requiredString(payload.session_id)) {
    return invalid('missing-field');
  }

  const transcriptPath = payload.transcript_path;
  if (transcriptPath !== null && typeof transcriptPath !== 'string') {
    return invalid('missing-field');
  }
  if (typeof transcriptPath === 'string' && transcriptPath.includes('\0')) {
    return invalid('unsafe-transcript-path');
  }

  const eventName = payload.hook_event_name;
  let phase: HookEnvelope['phase'];
  let externalTurnId: string | null = null;
  let externalCallId: string | null = null;
  let serverName: string | null = null;
  let toolName: string | null = null;

  switch (eventName) {
    case 'SessionStart':
      phase = 'session-start';
      break;
    case 'Stop':
      if (!requiredString(payload.turn_id)) return invalid('missing-field');
      phase = 'turn-stop';
      externalTurnId = payload.turn_id;
      break;
    case 'PreToolUse':
    case 'PostToolUse': {
      if (
        !requiredString(payload.turn_id)
        || !requiredString(payload.tool_name)
        || !requiredString(payload.tool_use_id)
      ) {
        return invalid('missing-field');
      }
      const toolMatch = MCP_TOOL_NAME.exec(payload.tool_name);
      if (toolMatch === null) return { kind: 'ignored', reason: 'non-mcp-tool' };

      phase = eventName === 'PreToolUse' ? 'tool-before' : 'tool-after';
      externalTurnId = payload.turn_id;
      externalCallId = payload.tool_use_id;
      [, serverName, toolName] = toolMatch;
      break;
    }
    default:
      return { kind: 'ignored', reason: 'unsupported-phase' };
  }

  const identity = {
    client: 'codex' as const,
    externalSessionId: payload.session_id,
    externalTurnId,
    externalCallId,
    phase,
    toolName,
    inputFingerprint: null,
  };

  return {
    kind: 'observation',
    observation: {
      schemaVersion: 1,
      deliveryId: makeDeliveryId(identity),
      client: 'codex',
      phase,
      receivedAt,
      externalSessionId: payload.session_id,
      externalTurnId,
      externalCallId,
      transcriptPath,
      serverName,
      toolName,
      observedAt: receivedAt,
      durationMs: null,
      isError: null,
      inputFingerprint: null,
      source: 'hook',
      correlationKey: makeCorrelationKey(identity),
      correlationConfidence: externalCallId === null ? 'medium' : 'high',
      responseTokens: null,
      loadedTokens: null,
    },
  };
};
