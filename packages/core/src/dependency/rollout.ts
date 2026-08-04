import type { ClientId } from '../types.js';

/**
 * Action surfaces are deliberately released after analysis itself.  Analysis,
 * cache reads, and details remain available in every stage, including shadow.
 */
export type DependencyAnalysisRollout = 'shadow' | 'claude' | 'codex-beta' | 'stable';

export const DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT: DependencyAnalysisRollout = 'shadow';

export function isDependencyAnalysisRollout(value: unknown): value is DependencyAnalysisRollout {
  return value === 'shadow' || value === 'claude' || value === 'codex-beta' || value === 'stable';
}

/** Returns whether a global disable/restore action may be exposed for this client. */
export function actionAllowedByRollout(
  rollout: DependencyAnalysisRollout | undefined,
  client: ClientId,
): boolean {
  const stage = rollout ?? DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT;
  if (client === 'claude-code') return stage !== 'shadow';
  if (client === 'codex') return stage === 'codex-beta' || stage === 'stable';
  return false;
}
