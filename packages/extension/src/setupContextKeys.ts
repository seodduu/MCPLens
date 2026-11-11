import type { InstallState } from './hookInstall.js';
import { migrateDependencyAnalysisRollout, DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT } from '@mcp-lens/core';

export interface SetupKeys {
  scanReady: boolean;
  hooksReady: boolean;
  analysisReady: boolean;
  globalActionsReady: boolean;
}

export interface SetupKeyInput {
  /** Detection results. client-missing is excluded from the verdict */
  installs: readonly { install: InstallState | string }[];
  definitionCount: number;
  consentAccepted: boolean;
  analyzedServerCount: number;
  /** Value of the mcplens.dependencyAnalysis.rollout setting. undefined when unset */
  rollout: string | undefined;
}

const STEP_PREFIX = 'seodduu.mcplens#mcpLens.setup#';

export const SETUP_STEP_IDS: Record<keyof SetupKeys, string> = {
  scanReady: `${STEP_PREFIX}scan`,
  hooksReady: `${STEP_PREFIX}hooks`,
  analysisReady: `${STEP_PREFIX}analyze`,
  globalActionsReady: `${STEP_PREFIX}actions`,
};

export function evaluateSetupKeys(input: SetupKeyInput): SetupKeys {
  // A client that is not installed leaves the user nothing to do, so it is removed from the denominator.
  const present = input.installs.filter((row) => row.install !== 'client-missing');
  return {
    scanReady: input.definitionCount > 0,
    // Counting needs-approval as true would produce a false success: a lit checkmark with zero collection.
    hooksReady: present.length > 0 && present.every((row) => row.install === 'installed'),
    analysisReady: input.consentAccepted && input.analyzedServerCount > 0,
    // No value equals the VS Code setting default (off). off means locked, so it must be false.
    // Even when an old value (shadow/codex-beta/stable) is stored, the verdict uses
    // migrateDependencyAnalysisRollout: a permission the user granted must not vanish right after an upgrade.
    globalActionsReady: (() => {
      const migrated = input.rollout === undefined
        ? DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT
        : migrateDependencyAnalysisRollout(input.rollout);
      return migrated !== undefined && migrated !== 'off';
    })(),
  };
}

/**
 * Step ids of keys that flipped from true to false.
 * Clearing them on every false would also erase what the user checked by hand.
 */
export function stepsToUncheck(prev: SetupKeys | undefined, next: SetupKeys): string[] {
  if (prev === undefined) return [];
  return (Object.keys(SETUP_STEP_IDS) as (keyof SetupKeys)[])
    .filter((key) => prev[key] && !next[key])
    .map((key) => SETUP_STEP_IDS[key]);
}

/** Step ids of keys that flipped from false to true. onContext fires once per session, so it cannot relight after a clear. */
export function stepsToComplete(prev: SetupKeys | undefined, next: SetupKeys): string[] {
  if (prev === undefined) return [];
  return (Object.keys(SETUP_STEP_IDS) as (keyof SetupKeys)[])
    .filter((key) => !prev[key] && next[key])
    .map((key) => SETUP_STEP_IDS[key]);
}
