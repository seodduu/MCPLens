import type { ClientId, DependencyStatus, IdentityConflictState } from '../types.js';

/**
 * Eligibility asks only "is applying this safe".
 * Usage judgements (recommendation, confidence, call count, collection health, recent restores) were
 * removed from the gate. The independence verdict and the extension's confirmation dialog cover those.
 */
export interface EligibilityInput {
  analysisStatus: DependencyStatus;
  identityConflictState: IdentityConflictState;
  hasDefinitionBody: boolean;
  hasActiveAction: boolean;
  client: ClientId;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export function actionEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (input.analysisStatus !== 'Independent') reasons.push('analysis-not-independent');
  if (input.identityConflictState !== 'clear') reasons.push('identity-not-clear');
  if (!input.hasDefinitionBody) reasons.push('missing-definition-body');
  if (input.hasActiveAction) reasons.push('active-action');
  if (input.client !== 'claude-code' && input.client !== 'codex') reasons.push('unsupported-client');
  return { eligible: reasons.length === 0, reasons };
}
