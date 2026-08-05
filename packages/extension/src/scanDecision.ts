// packages/extension/src/scanDecision.ts (never import vscode)
import type { McpServerSpec } from '@mcp-lens/core';

export type AutoScanSetting = 'prompt' | 'always' | 'never';

export type ScanAction =
  | { kind: 'skip' }
  | { kind: 'prompt'; targets: McpServerSpec[] }
  | { kind: 'scan'; targets: McpServerSpec[] };

export function decideScanAction(args: {
  setting: AutoScanSetting;
  specs: McpServerSpec[];
  /**
   * Names of servers whose definition bodies were ingested, meaning the scan really completed
   * (store.serversWithDefinitionBodies()). Judging by the presence of definitions alone would leave a
   * DB from before the body table was introduced never rescanned.
   */
  scannedServers: Set<string>;
  /** Names of servers judged unsupported by Lens: not even a scan is attempted */
  unsupported?: Set<string>;
  /**
   * This DB has never been scanned (zero definitions). That is the first run right after installation.
   * It is judged by the presence of definitions, not bodies: a DB from before the body table has
   * definitions but no bodies, so judging by bodies would mistake that user's rescan for a first run.
   */
  neverScanned?: boolean;
}): ScanAction {
  const targets = args.specs.filter(
    (s) => !args.scannedServers.has(s.name) && !(args.unsupported?.has(s.name)));
  if (targets.length === 0 || args.setting === 'never') return { kind: 'skip' };
  // The extension does not step in on the first run. The onboarding walkthrough guides the user
  // through scan, hooks, analysis and global actions themselves, and choosing the LLM provider for
  // the analysis is part of it. Scanning first would make that choice for them. Automatic scanning
  // applies only from the servers added after the user has scanned once.
  if (args.neverScanned) return { kind: 'skip' };
  if (args.setting === 'always') return { kind: 'scan', targets };
  return { kind: 'prompt', targets };
}
