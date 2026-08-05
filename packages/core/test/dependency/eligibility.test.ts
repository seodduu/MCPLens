import { describe, it, expect } from 'vitest';
import { actionEligibility, type EligibilityInput } from '../../src/dependency/eligibility.js';

describe('actionEligibility', () => {
  it('Independent이고 적용이 안전한 대상은 eligible이다', () => {
    expect(actionEligibility(base())).toEqual({ eligible: true, reasons: [] });
  });

  // 사용량 판단(권고·확신·호출 수·수집 건강도)은 더 이상 차단하지 않는다.
  // Independent 판정과 사람의 확인 대화상자가 그 자리를 대신한다.
  it('Independent이면 권고·호출 이력·수집 건강도와 무관하게 eligible이다', () => {
    expect(actionEligibility(base()).eligible).toBe(true);
  });

  it('적용 자체가 불가능하거나 대상이 틀어진 경우에만 false다', () => {
    expect(actionEligibility(base({ analysisStatus: 'Review required' }))).toEqual({ eligible: false, reasons: ['analysis-not-independent'] });
    expect(actionEligibility(base({ analysisStatus: 'Dependent' }))).toEqual({ eligible: false, reasons: ['analysis-not-independent'] });
    expect(actionEligibility(base({ identityConflictState: 'conflict' }))).toEqual({ eligible: false, reasons: ['identity-not-clear'] });
    expect(actionEligibility(base({ hasDefinitionBody: false }))).toEqual({ eligible: false, reasons: ['missing-definition-body'] });
    expect(actionEligibility(base({ hasActiveAction: true }))).toEqual({ eligible: false, reasons: ['active-action'] });
    expect(actionEligibility(base({ client: 'gemini-cli' }))).toEqual({ eligible: false, reasons: ['unsupported-client'] });
  });
});

function base(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    analysisStatus: 'Independent',
    identityConflictState: 'clear',
    hasDefinitionBody: true,
    hasActiveAction: false,
    client: 'claude-code',
    ...overrides,
  };
}
