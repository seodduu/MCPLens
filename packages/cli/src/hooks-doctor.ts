import type { HookClient, HookStatus } from './hooks-status.js';

export type DoctorLevel = 'ok' | 'warning' | 'failure';

export interface HookDiagnosis {
  client: HookClient;
  level: DoctorLevel;
  code: string;
  message: string;
}

export function diagnoseHooks(
  statuses: readonly HookStatus[],
  client?: HookClient,
): HookDiagnosis[] {
  return statuses
    .filter((status) => client === undefined || status.client === client)
    .flatMap(diagnoseHook)
    .sort((left, right) => left.client.localeCompare(right.client)
      || levelRank(left.level) - levelRank(right.level)
      || left.code.localeCompare(right.code));
}

export function formatHookDiagnosis(diagnoses: readonly HookDiagnosis[]): string {
  return diagnoses.map((diagnosis) =>
    `[${diagnosis.level.toUpperCase()}] ${diagnosis.client} ${diagnosis.code}: ${diagnosis.message}`,
  ).join('\n').concat(diagnoses.length === 0 ? '' : '\n');
}

function diagnoseHook(status: HookStatus): HookDiagnosis[] {
  const diagnoses: HookDiagnosis[] = [];
  if (status.packageState === 'missing') {
    diagnoses.push(failure(status.client, 'package-missing', 'MCP Lens hook package is not installed.'));
    return diagnoses;
  }
  if (status.runnerState === 'missing') {
    diagnoses.push(failure(status.client, 'runner-missing', 'Hook runner is missing or unreadable.'));
    return diagnoses;
  }

  diagnoses.push(ok(status.client, 'package-ready', 'Hook package and runner are available.'));
  if (status.client === 'codex') {
    if (status.trustState === 'unknown') {
      diagnoses.push(warning(status.client, 'codex-trust-unknown',
        'Codex hook trust cannot be read; review it with /hooks.'));
    } else if (status.trustState === 'unapproved') {
      diagnoses.push(warning(status.client, 'codex-trust-unapproved',
        'Codex hook trust is not approved; review it with /hooks.'));
    }
  }
  if (status.lastEvent === null) {
    diagnoses.push(warning(status.client, 'no-events', 'No hook event has been observed yet.'));
  }
  if (status.pendingCount > 0) {
    diagnoses.push(warning(status.client, 'pending-events',
      `${status.pendingCount} event${status.pendingCount === 1 ? '' : 's'} await processing.`));
  }
  if (status.health === 'degraded' || status.health === 'unavailable') {
    diagnoses.push(warning(status.client, `health-${status.health}`,
      `Collection health is ${status.health}.`));
  }
  return diagnoses;
}

function ok(client: HookClient, code: string, message: string): HookDiagnosis {
  return { client, level: 'ok', code, message };
}

function warning(client: HookClient, code: string, message: string): HookDiagnosis {
  return { client, level: 'warning', code, message };
}

function failure(client: HookClient, code: string, message: string): HookDiagnosis {
  return { client, level: 'failure', code, message };
}

function levelRank(level: DoctorLevel): number {
  switch (level) {
    case 'failure': return 0;
    case 'warning': return 1;
    case 'ok': return 2;
  }
}
