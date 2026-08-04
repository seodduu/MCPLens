import { describe, expect, it } from 'vitest';
import { actionAllowedByRollout, type DependencyAnalysisRollout } from '../../src/dependency/rollout.js';

describe('dependency analysis rollout', () => {
  const stages: readonly DependencyAnalysisRollout[] = ['shadow', 'claude', 'codex-beta', 'stable'];

  it('uses shadow as the default and permits no actions there', () => {
    expect(actionAllowedByRollout(undefined, 'claude-code')).toBe(false);
    expect(actionAllowedByRollout('shadow', 'claude-code')).toBe(false);
    expect(actionAllowedByRollout('shadow', 'codex')).toBe(false);
  });

  it('opens actions progressively by supported client only', () => {
    expect(stages.map((stage) => actionAllowedByRollout(stage, 'claude-code'))).toEqual([false, true, true, true]);
    expect(stages.map((stage) => actionAllowedByRollout(stage, 'codex'))).toEqual([false, false, true, true]);
    expect(stages.map((stage) => actionAllowedByRollout(stage, 'gemini-cli'))).toEqual([false, false, false, false]);
  });
});
