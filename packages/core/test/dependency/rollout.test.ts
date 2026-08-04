import { describe, expect, it } from 'vitest';
import {
  actionAllowedByRollout,
  migrateDependencyAnalysisRollout,
  type DependencyAnalysisRollout,
} from '../../src/dependency/rollout.js';

describe('dependency analysis rollout', () => {
  it('off는 어떤 클라이언트도 허용하지 않는다', () => {
    expect(actionAllowedByRollout('off', 'claude-code')).toBe(false);
    expect(actionAllowedByRollout('off', 'codex')).toBe(false);
    expect(actionAllowedByRollout('off', 'gemini-cli')).toBe(false);
  });

  it('claude는 claude-code만 허용한다', () => {
    expect(actionAllowedByRollout('claude', 'claude-code')).toBe(true);
    expect(actionAllowedByRollout('claude', 'codex')).toBe(false);
    expect(actionAllowedByRollout('claude', 'gemini-cli')).toBe(false);
  });

  it('codex는 codex만 허용한다', () => {
    // codex-beta와 달리 claude-code는 이제 허용되지 않는다 — 이번 변경의 핵심 동작 변화.
    expect(actionAllowedByRollout('codex', 'codex')).toBe(true);
    expect(actionAllowedByRollout('codex', 'claude-code')).toBe(false);
    expect(actionAllowedByRollout('codex', 'gemini-cli')).toBe(false);
  });

  it('all은 claude-code와 codex를 허용한다', () => {
    expect(actionAllowedByRollout('all', 'claude-code')).toBe(true);
    expect(actionAllowedByRollout('all', 'codex')).toBe(true);
    expect(actionAllowedByRollout('all', 'gemini-cli')).toBe(false);
  });

  it('gemini-cli는 모든 값에서 거부된다', () => {
    const values: readonly DependencyAnalysisRollout[] = ['off', 'claude', 'codex', 'all'];
    expect(values.map((v) => actionAllowedByRollout(v, 'gemini-cli'))).toEqual([false, false, false, false]);
  });

  it('undefined는 기본값 off로 취급한다', () => {
    expect(actionAllowedByRollout(undefined, 'claude-code')).toBe(false);
    expect(actionAllowedByRollout(undefined, 'codex')).toBe(false);
  });

  describe('migrateDependencyAnalysisRollout', () => {
    it('shadow는 off로 옮겨간다', () => {
      expect(migrateDependencyAnalysisRollout('shadow')).toBe('off');
    });

    it('codex-beta는 all로 옮겨간다', () => {
      expect(migrateDependencyAnalysisRollout('codex-beta')).toBe('all');
    });

    it('stable은 all로 옮겨간다', () => {
      expect(migrateDependencyAnalysisRollout('stable')).toBe('all');
    });

    it('claude는 claude로 그대로 남는다', () => {
      expect(migrateDependencyAnalysisRollout('claude')).toBe('claude');
    });

    it('알 수 없는 값은 undefined다', () => {
      expect(migrateDependencyAnalysisRollout('nonsense')).toBeUndefined();
      expect(migrateDependencyAnalysisRollout(undefined)).toBeUndefined();
    });
  });
});
