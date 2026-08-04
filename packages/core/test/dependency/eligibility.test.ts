import { describe, it, expect } from 'vitest';
import { actionEligibility, type EligibilityInput } from '../../src/dependency/eligibility.js';

describe('actionEligibility', () => {
  it('remove/filter-server high confidence, zero calls, independent, clear healthy Claude/Codex target만 eligible이다', () => {
    expect(actionEligibility(base())).toEqual({ eligible: true, reasons: [] });
  });

  it('하나라도 불명확하면 false와 machine-readable reason을 반환한다', () => {
    expect(actionEligibility(base({ callCount: 1 }))).toEqual({ eligible: false, reasons: ['called'] });
    expect(actionEligibility(base({ analysisStatus: 'Review required' }))).toEqual({ eligible: false, reasons: ['analysis-not-independent'] });
    expect(actionEligibility(base({ identityConflictState: 'conflict' }))).toEqual({ eligible: false, reasons: ['identity-not-clear'] });
    expect(actionEligibility(base({ collectionHealth: 'degraded' }))).toEqual({ eligible: false, reasons: ['collection-health-unsafe'] });
    expect(actionEligibility(base({ hasDefinitionBody: false }))).toEqual({ eligible: false, reasons: ['missing-definition-body'] });
    expect(actionEligibility(base({ hasActiveAction: true }))).toEqual({ eligible: false, reasons: ['active-action'] });
    expect(actionEligibility(base({ client: 'gemini-cli' }))).toEqual({ eligible: false, reasons: ['unsupported-client'] });
    expect(actionEligibility(base({ recentRestoredSameDefinition: true }))).toEqual({ eligible: false, reasons: ['recent-restore'] });
  });
});

function base(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    recommendationAction: 'remove',
    recommendationConfidence: 'high',
    callCount: 0,
    analysisStatus: 'Independent',
    identityConflictState: 'clear',
    collectionHealth: 'healthy',
    hasDefinitionBody: true,
    hasActiveAction: false,
    client: 'claude-code',
    recentRestoredSameDefinition: false,
    ...overrides,
  };
}
