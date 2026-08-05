import type { ClientId, DependencyStatus, IdentityConflictState } from '../types.js';

/**
 * 적격성은 "적용이 안전한가"만 본다.
 * 사용량 판단(권고·확신·호출 수·수집 건강도·최근 복원)은 게이트에서 뺐다.
 * Independent 판정과 확장이 띄우는 확인 대화상자가 그 판단을 대신한다.
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
