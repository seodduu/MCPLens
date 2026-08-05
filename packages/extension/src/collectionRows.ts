// Never import vscode: this is a pure row builder for one group of the Setup Status view.
import { clientRowPresentation, type CollectionHealthPresentation, type CollectionHealthSnapshot } from './hookStatus.js';
import type { HookClient, InstallState } from './hookInstall.js';
import type { SetupIcon, SetupRow } from './setupTree.js';

const ICON: Record<CollectionHealthPresentation['severity'], SetupIcon> = {
  ok: 'pass', info: 'clock', warning: 'warning', error: 'error', idle: 'circle-outline',
};

/** Collection status colour: blue when the hook is alive, orange for logs only, red when neither exists. */
function collectionColor(snapshot?: CollectionHealthSnapshot): string {
  if (snapshot?.hookObserved) return 'charts.blue';
  if (snapshot?.logObserved) return 'charts.orange';
  return 'charts.red';
}

export interface ClientRowInput {
  client: HookClient;
  install: InstallState;
  snapshot?: CollectionHealthSnapshot;
}

export interface ClientRow {
  client: HookClient;
  label: string;
  description: string;
  tooltip: string;
  severity: CollectionHealthPresentation['severity'];
  /** Icon accent colour: hook blue / logs-only orange / none red */
  colorId: string;
  contextValue: 'hook-installable' | 'hook-installed';
}

export function toRow(input: ClientRowInput): ClientRow {
  const p = clientRowPresentation(input.install, input.snapshot);
  return {
    client: input.client,
    label: `${input.client}: ${p.label}`,
    description: p.description,
    tooltip: p.tooltip,
    severity: p.severity,
    colorId: collectionColor(input.snapshot),
    contextValue: input.install === 'not-installed' ? 'hook-installable' : 'hook-installed',
  };
}

/**
 * Builds the per-client collection status as rows of the Collection group in the Setup Status view.
 * `client-missing` (that client is not installed at all) has nothing to show, so it is excluded.
 */
export function collectionRows(inputs: ClientRowInput[]): SetupRow[] {
  return inputs.filter((i) => i.install !== 'client-missing').map(toRow).map((row): SetupRow => ({
    group: 'Collection',
    label: row.label,
    description: row.description,
    icon: ICON[row.severity],
    tooltip: row.tooltip,
    colorId: row.colorId,
    contextValue: row.contextValue,
    id: row.client,
    // Healthy rows carry no click action: there is nothing to fix on them.
    ...(row.severity === 'warning' || row.severity === 'error'
      ? { command: 'mcp-lens.hooksDoctor', commandArgs: [row.client] }
      : {}),
  }));
}
