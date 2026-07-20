import type { AdapterResult, ToolCallEvent, ToolLoadEvent } from '../types.js';
import type { HookPhase, ToolObservation } from './contracts.js';
import { makeCorrelationKey, makeDeliveryId, type IdentityInput } from './identity.js';

export type NativeCallIds = readonly (string | null | undefined)[];
export interface TurnAwareAdapterResult extends AdapterResult {
  readonly toolCallTurnIds?: readonly (string | null | undefined)[];
}

const UNKNOWN_TIME = '1970-01-01T00:00:00.000Z';

/** Convert redacted adapter metering into correlation-ready log observations. */
export function adapterResultToObservations(
  result: AdapterResult,
  nativeIds: NativeCallIds,
): ToolObservation[] {
  const turnAwareResult = result as TurnAwareAdapterResult;
  const externalSessionId = nativeId(result.session.externalSessionId)
    ?? result.session.sessionId;
  const calls = result.toolCalls.map((call, index) => callObservation(
    result,
    call,
    externalSessionId,
    nativeId(call.externalCallId) ?? nativeId(nativeIds[index]),
    nativeId(turnAwareResult.toolCallTurnIds?.[index]),
  ));
  const loads = result.toolLoads.map((load) => loadObservation(result, load, externalSessionId));
  return [...calls, ...loads];
}

function callObservation(
  result: AdapterResult,
  call: ToolCallEvent,
  externalSessionId: string,
  externalCallId: string | null,
  externalTurnId: string | null,
): ToolObservation {
  const phase: HookPhase = call.isError ? 'tool-failure' : 'tool-after';
  const observedAt = call.calledAt ?? result.session.startedAt ?? UNKNOWN_TIME;
  return observation(result, {
    externalSessionId,
    externalTurnId,
    externalCallId,
    phase,
    serverName: call.serverName,
    toolName: call.toolName,
    observedAt,
    durationMs: call.durationMs,
    isError: call.isError,
    responseTokens: call.responseTokens,
    loadedTokens: null,
  });
}

function loadObservation(
  result: AdapterResult,
  load: ToolLoadEvent,
  externalSessionId: string,
): ToolObservation {
  return observation(result, {
    externalSessionId,
    externalTurnId: null,
    externalCallId: null,
    phase: 'tool-before',
    serverName: load.serverName,
    toolName: load.toolName,
    observedAt: result.session.startedAt ?? UNKNOWN_TIME,
    durationMs: null,
    isError: null,
    responseTokens: null,
    loadedTokens: load.loadedTokens,
  });
}

function observation(
  result: AdapterResult,
  fields: {
    externalSessionId: string;
    externalTurnId: string | null;
    externalCallId: string | null;
    phase: HookPhase;
    serverName: string | null;
    toolName: string | null;
    observedAt: string;
    durationMs: number | null;
    isError: boolean | null;
    responseTokens: number | null;
    loadedTokens: number | null;
  },
): ToolObservation {
  const identity: IdentityInput = {
    client: result.session.client,
    externalSessionId: fields.externalSessionId,
    externalTurnId: fields.externalTurnId,
    externalCallId: fields.externalCallId,
    phase: fields.phase,
    toolName: fields.toolName,
    inputFingerprint: null,
  };
  // Gemini Hook payloads expose no call ID. Keep the real log call ID for
  // delivery cardinality, but correlate both sources through H4's fallback.
  const correlationIdentity: IdentityInput = result.session.client === 'gemini-cli'
    ? { ...identity, externalCallId: null }
    : identity;
  return {
    schemaVersion: 1,
    deliveryId: makeDeliveryId(identity),
    source: 'log',
    correlationKey: makeCorrelationKey(correlationIdentity),
    correlationConfidence: correlationIdentity.externalCallId ? 'high' : 'low',
    client: result.session.client,
    phase: fields.phase,
    receivedAt: fields.observedAt,
    externalSessionId: fields.externalSessionId,
    externalTurnId: fields.externalTurnId,
    externalCallId: fields.externalCallId,
    transcriptPath: result.session.filePath,
    serverName: fields.serverName,
    toolName: fields.toolName,
    observedAt: fields.observedAt,
    durationMs: fields.durationMs,
    isError: fields.isError,
    inputFingerprint: null,
    responseTokens: fields.responseTokens,
    loadedTokens: fields.loadedTokens,
  };
}

function nativeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
