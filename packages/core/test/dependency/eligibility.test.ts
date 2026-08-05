import { describe, it, expect } from 'vitest';
import { actionEligibility, type EligibilityInput } from '../../src/dependency/eligibility.js';

describe('actionEligibility', () => {
  it('marks an Independent target that is safe to apply as eligible', () => {
    expect(actionEligibility(base())).toEqual({ eligible: true, reasons: [] });
  });

  // Usage judgements (recommendation, confidence, call count, collection health) no longer block.
  // The independence verdict and the human confirmation dialog take their place.
  it('marks anything Independent eligible regardless of recommendation, call history or collection health', () => {
    expect(actionEligibility(base()).eligible).toBe(true);
  });

  it('is false only when applying is impossible or the target is wrong', () => {
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
