import { describe, it, expect } from 'vitest';
import {
  evaluateSetupKeys,
  stepsToUncheck,
  stepsToComplete,
  SETUP_STEP_IDS,
} from '../src/setupContextKeys.js';

const base = {
  installs: [] as { install: string }[],
  definitionCount: 0,
  consentAccepted: false,
  analyzedServerCount: 0,
  rollout: undefined as string | undefined,
};

describe('evaluateSetupKeys', () => {
  it('makes scanReady false with 0 definitions', () => {
    expect(evaluateSetupKeys({ ...base }).scanReady).toBe(false);
  });

  it('makes scanReady true with at least one definition', () => {
    expect(evaluateSetupKeys({ ...base, definitionCount: 3 }).scanReady).toBe(true);
  });

  it('makes hooksReady false when no client is detected', () => {
    expect(evaluateSetupKeys({ ...base, installs: [] }).hooksReady).toBe(false);
  });

  it('makes hooksReady true when every detected client is installed', () => {
    const installs = [{ install: 'installed' }, { install: 'installed' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(true);
  });

  it('makes hooksReady false when any client is needs-approval', () => {
    const installs = [{ install: 'installed' }, { install: 'needs-approval' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(false);
  });

  it('excludes client-missing clients from the verdict', () => {
    const installs = [{ install: 'installed' }, { install: 'client-missing' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(true);
  });

  it('makes hooksReady false when everything is client-missing', () => {
    const installs = [{ install: 'client-missing' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(false);
  });

  it('makes analysisReady false without consent, even with analysis results', () => {
    expect(evaluateSetupKeys({ ...base, analyzedServerCount: 2 }).analysisReady).toBe(false);
  });

  it('makes analysisReady true with consent and at least one analysis result', () => {
    expect(evaluateSetupKeys({
      ...base, consentAccepted: true, analyzedServerCount: 1 }).analysisReady).toBe(true);
  });

  it('makes analysisReady false with consent but no analysis results', () => {
    expect(evaluateSetupKeys({ ...base, consentAccepted: true }).analysisReady).toBe(false);
  });

  it('makes globalActionsReady false when rollout is off', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'off' }).globalActionsReady).toBe(false);
  });

  it('makes globalActionsReady false when rollout is unset', () => {
    expect(evaluateSetupKeys({ ...base, rollout: undefined }).globalActionsReady).toBe(false);
  });

  it('makes globalActionsReady true when rollout is claude', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'claude' }).globalActionsReady).toBe(true);
  });

  it('makes globalActionsReady true when rollout is all', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'all' }).globalActionsReady).toBe(true);
  });

  it('makes globalActionsReady false when the old value shadow is stored', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'shadow' }).globalActionsReady).toBe(false);
  });

  it('makes globalActionsReady true for the stored old value codex-beta, via the migrated all', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'codex-beta' }).globalActionsReady).toBe(true);
  });

  it('makes globalActionsReady true for the stored old value stable, via the migrated all', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'stable' }).globalActionsReady).toBe(true);
  });
});

describe('stepsToUncheck', () => {
  const on = { scanReady: true, hooksReady: true, analysisReady: true, globalActionsReady: true };
  const off = { scanReady: false, hooksReady: false, analysisReady: false, globalActionsReady: false };

  it('returns the step ids of keys that flipped from true to false', () => {
    expect(stepsToUncheck(on, { ...on, hooksReady: false })).toEqual([SETUP_STEP_IDS.hooksReady]);
  });

  it('returns nothing for false to false', () => {
    expect(stepsToUncheck(off, off)).toEqual([]);
  });

  it('returns nothing for false to true', () => {
    expect(stepsToUncheck(off, on)).toEqual([]);
  });

  it('returns nothing when there is no previous state (the first verdict)', () => {
    expect(stepsToUncheck(undefined, off)).toEqual([]);
  });

  it('normalizes step ids with the extension identifier and walkthrough id', () => {
    expect(SETUP_STEP_IDS.hooksReady).toBe('seodduu.mcplens#mcpLens.setup#hooks');
    expect(SETUP_STEP_IDS.scanReady).toBe('seodduu.mcplens#mcpLens.setup#scan');
    expect(SETUP_STEP_IDS.analysisReady).toBe('seodduu.mcplens#mcpLens.setup#analyze');
  });

  it('uses seodduu.mcplens#mcpLens.setup#actions as the actions step id', () => {
    expect(SETUP_STEP_IDS.globalActionsReady).toBe('seodduu.mcplens#mcpLens.setup#actions');
  });

  it('returns the actions step id for clearing when globalActionsReady flips true to false', () => {
    expect(stepsToUncheck(on, { ...on, globalActionsReady: false }))
      .toEqual([SETUP_STEP_IDS.globalActionsReady]);
  });
});

describe('stepsToComplete', () => {
  const on = { scanReady: true, hooksReady: true, analysisReady: true, globalActionsReady: true };
  const off = { scanReady: false, hooksReady: false, analysisReady: false, globalActionsReady: false };

  it('returns the step id when it flips from false to true', () => {
    expect(stepsToComplete(off, { ...off, hooksReady: true })).toEqual([SETUP_STEP_IDS.hooksReady]);
  });

  it('returns nothing for true to true', () => {
    expect(stepsToComplete(on, on)).toEqual([]);
  });

  it('returns nothing for true to false', () => {
    expect(stepsToComplete(on, { ...on, hooksReady: false })).toEqual([]);
  });

  it('returns nothing when there is no previous state', () => {
    expect(stepsToComplete(undefined, on)).toEqual([]);
  });

  it('returns every key that lights up at once', () => {
    const result = stepsToComplete(off, { ...off, hooksReady: true, scanReady: true });
    expect(result.sort()).toEqual(
      [SETUP_STEP_IDS.hooksReady, SETUP_STEP_IDS.scanReady].sort(),
    );
  });

  it('never fills both stepsToComplete and stepsToUncheck on the same transition', () => {
    const prev = { ...off, hooksReady: true };
    const next = { ...off, scanReady: true };
    expect(stepsToUncheck(prev, next)).toEqual([SETUP_STEP_IDS.hooksReady]);
    expect(stepsToComplete(prev, next)).toEqual([SETUP_STEP_IDS.scanReady]);
  });
});
