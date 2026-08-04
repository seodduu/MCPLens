import type { ClientId } from '../types.js';
export type ObservationSource = 'hook' | 'log' | 'proxy';
/** `tool-before` also represents an observed direct request before a tool executes. */
export type HookPhase = 'session-start' | 'tool-before' | 'tool-after' | 'tool-failure' | 'turn-stop' | 'session-end';
export type CorrelationConfidence = 'high' | 'medium' | 'low';
export type CollectionHealth = 'idle' | 'healthy' | 'hook-only' | 'log-only' | 'degraded' | 'unavailable';
export interface HookEnvelope { schemaVersion: 1; deliveryId: string; client: ClientId; phase: HookPhase; receivedAt: string; externalSessionId: string; externalTurnId: string | null; externalCallId: string | null; transcriptPath: string | null; serverName: string | null; toolName: string | null; observedAt: string; durationMs: number | null; isError: boolean | null; inputFingerprint: string | null; }
export interface ToolObservation extends HookEnvelope { source: ObservationSource; correlationKey: string; correlationConfidence: CorrelationConfidence; responseTokens: number | null; loadedTokens: number | null; }
export type HookDecoder = (input: unknown, receivedAt: string) => HookNormalizationResult;
export type HookNormalizationResult = { kind: 'observation'; observation: ToolObservation } | { kind: 'ignored'; reason: 'non-mcp-tool' | 'unsupported-phase' } | { kind: 'invalid'; code: 'invalid-json' | 'missing-field' | 'unsafe-transcript-path' };
