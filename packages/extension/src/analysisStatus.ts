import type { InferenceProvider, InferenceRunErrorCode } from './inferenceCli.js';

export type AnalysisCacheStatus = 'hit' | 'miss';
export type AnalysisStatusErrorCode =
  | 'authentication-failed'
  | 'invalid-output'
  | 'provider-unavailable'
  | InferenceRunErrorCode;

/** The deliberately small, safe-to-store telemetry contract for one analysis run. */
export interface AnalysisStatus {
  cache: AnalysisCacheStatus;
  provider: InferenceProvider;
  model: string;
  serverCount: number;
  toolCount: number;
  estimatedDefinitionTokens: number;
  sentDefinitionTokens: number;
  durationMs: number;
  errorCode: AnalysisStatusErrorCode | null;
}

/** Input may carry caller-local data, but only AnalysisStatus fields are retained. */
export type AnalysisStatusInput = AnalysisStatus & Record<string, unknown>;

export function createAnalysisStatus(input: AnalysisStatusInput): AnalysisStatus {
  return {
    cache: input.cache,
    provider: input.provider,
    model: input.model,
    serverCount: input.serverCount,
    toolCount: input.toolCount,
    estimatedDefinitionTokens: input.estimatedDefinitionTokens,
    sentDefinitionTokens: input.sentDefinitionTokens,
    durationMs: input.durationMs,
    errorCode: input.errorCode,
  };
}

/** User-facing failures never contain CLI stderr, prompts, definitions, or schemas. */
export function analysisFailureMessage(errorCode: AnalysisStatusErrorCode): string {
  switch (errorCode) {
    case 'authentication-failed': return 'Authentication failed. Check the selected provider account.';
    case 'timeout': return 'Dependency analysis timed out.';
    case 'invalid-json':
    case 'invalid-output':
    case 'schema-mismatch': return 'The provider returned invalid output.';
    case 'provider-unavailable': return 'The selected provider is unavailable.';
    case 'cancelled': return 'Dependency analysis was cancelled.';
    case 'nonzero': return 'The provider could not complete dependency analysis.';
  }
}

export function formatAnalysisStatus(status: AnalysisStatus): string {
  const cache = status.cache === 'hit' ? 'Cache hit' : 'Cache miss';
  const summary = `${cache} · ${status.provider} / ${status.model} · ${status.serverCount} servers · ${status.toolCount} tools · `
    + `${status.estimatedDefinitionTokens} estimated definition tokens · ${status.sentDefinitionTokens} sent definition tokens · ${status.durationMs} ms`;
  return status.errorCode === null ? summary : `${summary} · ${analysisFailureMessage(status.errorCode)}`;
}
