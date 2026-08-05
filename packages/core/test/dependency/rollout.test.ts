import { describe, expect, it } from 'vitest';
import {
  actionAllowedByRollout,
  migrateDependencyAnalysisRollout,
  type DependencyAnalysisRollout,
} from '../../src/dependency/rollout.js';

describe('dependency analysis rollout', () => {
  it('allows no client on off', () => {
    expect(actionAllowedByRollout('off', 'claude-code')).toBe(false);
    expect(actionAllowedByRollout('off', 'codex')).toBe(false);
    expect(actionAllowedByRollout('off', 'gemini-cli')).toBe(false);
  });

  it('allows only claude-code on claude', () => {
    expect(actionAllowedByRollout('claude', 'claude-code')).toBe(true);
    expect(actionAllowedByRollout('claude', 'codex')).toBe(false);
    expect(actionAllowedByRollout('claude', 'gemini-cli')).toBe(false);
  });

  it('allows only codex on codex', () => {
    // Unlike codex-beta, claude-code is no longer allowed: the key behavioural change of this revision.
    expect(actionAllowedByRollout('codex', 'codex')).toBe(true);
    expect(actionAllowedByRollout('codex', 'claude-code')).toBe(false);
    expect(actionAllowedByRollout('codex', 'gemini-cli')).toBe(false);
  });

  it('allows claude-code and codex on all', () => {
    expect(actionAllowedByRollout('all', 'claude-code')).toBe(true);
    expect(actionAllowedByRollout('all', 'codex')).toBe(true);
    expect(actionAllowedByRollout('all', 'gemini-cli')).toBe(false);
  });

  it('rejects gemini-cli at every value', () => {
    const values: readonly DependencyAnalysisRollout[] = ['off', 'claude', 'codex', 'all'];
    expect(values.map((v) => actionAllowedByRollout(v, 'gemini-cli'))).toEqual([false, false, false, false]);
  });

  it('treats undefined as the default off', () => {
    expect(actionAllowedByRollout(undefined, 'claude-code')).toBe(false);
    expect(actionAllowedByRollout(undefined, 'codex')).toBe(false);
  });

  describe('migrateDependencyAnalysisRollout', () => {
    it('migrates shadow to off', () => {
      expect(migrateDependencyAnalysisRollout('shadow')).toBe('off');
    });

    it('migrates codex-beta to all', () => {
      expect(migrateDependencyAnalysisRollout('codex-beta')).toBe('all');
    });

    it('migrates stable to all', () => {
      expect(migrateDependencyAnalysisRollout('stable')).toBe('all');
    });

    it('leaves claude as claude', () => {
      expect(migrateDependencyAnalysisRollout('claude')).toBe('claude');
    });

    it('maps an unknown value to undefined', () => {
      expect(migrateDependencyAnalysisRollout('nonsense')).toBeUndefined();
      expect(migrateDependencyAnalysisRollout(undefined)).toBeUndefined();
    });
  });
});
