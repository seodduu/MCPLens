import type {
  ClientId, DependencyStatus, IdentityConflictState, RecommendationConfidence,
} from '../types.js';

export interface EligibilityInput {
  recommendationAction: 'remove' | 'filter-server' | 'keep' | 'unknown' | 'inspect';
  recommendationConfidence: RecommendationConfidence;
  callCount: number;
  analysisStatus: DependencyStatus;
  identityConflictState: IdentityConflictState;
  collectionHealth: 'healthy' | 'log-only' | 'hook-only' | 'degraded' | 'unavailable' | string;
  hasDefinitionBody: boolean;
  hasActiveAction: boolean;
  client: ClientId;
  recentRestoredSameDefinition: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export function actionEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (input.recommendationAction !== 'remove' && input.recommendationAction !== 'filter-server') {
    reasons.push('recommendation-not-actionable');
  }
  if (input.recommendationConfidence !== 'high') reasons.push('confidence-not-high');
  if (input.callCount !== 0) reasons.push('called');
  if (input.analysisStatus !== 'Independent') reasons.push('analysis-not-independent');
  if (input.identityConflictState !== 'clear') reasons.push('identity-not-clear');
  if (input.collectionHealth !== 'healthy' && input.collectionHealth !== 'log-only') {
    reasons.push('collection-health-unsafe');
  }
  if (!input.hasDefinitionBody) reasons.push('missing-definition-body');
  if (input.hasActiveAction) reasons.push('active-action');
  if (input.client !== 'claude-code' && input.client !== 'codex') reasons.push('unsupported-client');
  if (input.recentRestoredSameDefinition) reasons.push('recent-restore');
  return { eligible: reasons.length === 0, reasons };
}
