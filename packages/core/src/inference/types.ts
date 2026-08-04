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

export interface ValidatedInferenceResult {
  results: ToolDependencyResult[];
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
