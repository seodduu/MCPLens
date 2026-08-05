import type { InstallState } from './hookInstall.js';

export type CollectionHealth =
  | 'idle'
  | 'healthy'
  | 'hook-only'
  | 'log-only'
  | 'degraded'
  | 'unavailable';

/** Public core snapshot shape consumed by the extension. */
export interface CollectionHealthSnapshot {
  health: CollectionHealth;
  hookObserved: boolean;
  logObserved: boolean;
  consecutiveMisses: number;
  consecutiveMatches: number;
  waitingForCorrelation: number;
  lastEventAt: string | null;
}

export interface CollectionHealthPresentation {
  label: string;
  description: string;
  tooltip: string;
  severity: 'ok' | 'info' | 'warning' | 'error' | 'idle';
}

export function formatCollectionHealth(
  snapshot: CollectionHealthSnapshot,
  options: { hooksConfigured?: boolean } = {},
): CollectionHealthPresentation {
  switch (snapshot.health) {
    case 'healthy':
      return present('Healthy', 'Hook+log', 'Hook and log agree on recent calls.', 'ok');
    case 'hook-only':
      return present('Partially measured', 'Hook only, no token detail',
        'Hook calls are being collected, but log token detail has not been confirmed yet.', 'info');
    case 'log-only':
      return present('Partially measured', 'Log only, relies on an unofficial format',
        'Only the log is being collected. Check the hook installation and trust status.', 'warning');
    case 'degraded':
      return present('Degraded', `${snapshot.consecutiveMisses} consecutive correlation misses`,
        'Collection quality is low, so removal recommendations are downgraded to candidates.', 'warning');
    case 'unavailable':
      return present('Needs review', 'Neither hook nor log can be confirmed',
        'Check hook installation and trust status, and client log access permissions.', 'error');
    case 'idle':
      if (options.hooksConfigured) {
        return present('Waiting for first event', 'Waiting for a hook or log event',
          'Collection is configured. Status updates after the first MCP call.', 'info');
      }
      return present('Idle', 'No recent MCP collection events',
        'No recent MCP activity or log changes, so collection quality cannot be judged.', 'idle');
  }
}

export function clientRowPresentation(
  install: InstallState,
  snapshot: CollectionHealthSnapshot | undefined,
): CollectionHealthPresentation {
  if (install === 'not-installed') {
    return present('Not connected', 'Install needed',
      'The hook is not installed. Installing it collects MCP calls from this client.', 'warning');
  }
  if (install === 'needs-approval') {
    return present('Awaiting approval', 'codex consent needed',
      'The hook is on, but codex trust approval is still pending. Run codex once to see the consent prompt. '
      + 'Until it is approved, MCP calls from this client are collected from the log only.', 'warning');
  }
  // installed: its health when observations exist, otherwise idle (waiting for the first event)
  return formatCollectionHealth(
    snapshot ?? { health: 'idle', hookObserved: false, logObserved: false,
      consecutiveMisses: 0, consecutiveMatches: 0, waitingForCorrelation: 0, lastEventAt: null },
    { hooksConfigured: true },
  );
}

function present(
  label: string,
  description: string,
  tooltip: string,
  severity: CollectionHealthPresentation['severity'],
): CollectionHealthPresentation {
  return { label, description, tooltip, severity };
}
