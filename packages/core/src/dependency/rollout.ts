import type { ClientId } from '../types.js';

/**
 * Action surfaces are deliberately released after analysis itself.  Analysis,
 * cache reads, and details remain available for every value, including off.
 */
export type DependencyAnalysisRollout = 'off' | 'claude' | 'codex' | 'all';

export const DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT: DependencyAnalysisRollout = 'off';

export function isDependencyAnalysisRollout(value: unknown): value is DependencyAnalysisRollout {
  return value === 'off' || value === 'claude' || value === 'codex' || value === 'all';
}

/** Returns whether a global disable/restore action may be exposed for this client. */
export function actionAllowedByRollout(
  rollout: DependencyAnalysisRollout | undefined,
  client: ClientId,
): boolean {
  const value = rollout ?? DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT;
  if (client === 'claude-code') return value === 'claude' || value === 'all';
  if (client === 'codex') return value === 'codex' || value === 'all';
  return false; // gemini-cli는 어떤 값에서도 허용하지 않는다.
}

/**
 * 구 값(shadow/codex-beta/stable)을 새 값으로 옮긴다. 모르는 값은 undefined.
 *
 * 구 codex-beta와 stable은 둘 다 claude-code와 codex를 함께 허용했다. 따라서
 * 그 두 값을 그대로 codex로 옮기면 사용자가 이미 부여했던 claude-code 권한을
 * 조용히 빼앗는 셈이 된다. all로 옮기는 것만이 권한을 유지하는 유일한 매핑이다.
 */
export function migrateDependencyAnalysisRollout(value: unknown): DependencyAnalysisRollout | undefined {
  if (value === 'shadow') return 'off';
  if (value === 'codex-beta' || value === 'stable') return 'all';
  if (isDependencyAnalysisRollout(value)) return value;
  return undefined;
}
