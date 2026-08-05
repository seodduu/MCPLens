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
  return false; // gemini-cli is never allowed, at any value.
}

/**
 * Migrates old values (shadow/codex-beta/stable) to the new ones. Unknown values give undefined.
 *
 * The old codex-beta and stable both allowed claude-code together with codex. Migrating those two
 * to codex would therefore silently strip a claude-code permission the user had already granted.
 * Migrating to all is the only mapping that preserves the permission.
 */
export function migrateDependencyAnalysisRollout(value: unknown): DependencyAnalysisRollout | undefined {
  if (value === 'shadow') return 'off';
  if (value === 'codex-beta' || value === 'stable') return 'all';
  if (isDependencyAnalysisRollout(value)) return value;
  return undefined;
}
