import type { StateConsumerHint } from '../types.js';

export type InferenceProvider = 'claude' | 'codex';
export type DependencyStatus = 'Independent' | 'Review required' | 'Dependent';

export interface InferenceToolInput {
  toolName: string;
  description: string | null;
  inputSchemaJson: string;
  definitionTokens: number;
  staticReferences: readonly string[];
  callChainSummary: readonly InferenceCallChainSummary[];
}

export interface InferenceCallChainSummary {
  targetServerName: string;
  targetToolName: string;
  sessionCount: number;
  beforeRate: number;
}

export interface InferenceServerInput {
  serverName: string;
  tools: readonly InferenceToolInput[];
  /**
   * Tools detected as operating on ambient state. Empty when none were found.
   * Optional only until the analyzer wiring always supplies it; treat a missing
   * value as an empty list.
   */
  stateConsumers?: readonly StateConsumerHint[];
}

export interface InferenceBatch {
  batchId: string;
  servers: readonly InferenceServerInput[];
  payloadTokens: number;
  oversized: boolean;
}

export interface ToolDependencyResult {
  serverName: string;
  toolName: string;
  status: DependencyStatus;
  dependedOnBy: string[];
  rationale: string;
  displaySummary: string | null;
  whatYouLose: string | null;
  riskWithoutTool: string | null;
}

/** An ordering the model inferred from definitions alone. Advisory: it can only downgrade a verdict. */
export interface PredictedPrerequisite {
  toolName: string;
  requires: readonly string[];
  basis: string;
}

export interface ValidatedInferenceResult {
  results: ToolDependencyResult[];
  predictedPrerequisites: PredictedPrerequisite[];
}

export interface InferenceCostEstimate {
  provider: InferenceProvider;
  rateDate: '2026-08-03';
  inputTokens: { min: number; max: number };
  outputTokens: { min: number; max: number };
  inputUsd: { min: number; max: number };
  outputUsd: { min: number; max: number };
  totalUsd: { min: number; max: number };
  disclaimer: string;
}
