import type { ServerScanStatus } from '@mcp-lens/core';

/** The four top-level groups of the Setup Status view. The order is fixed and the tree renders in it.
 * Collection absorbed the old Collection Status view: with only two or three rows it took a whole
 * sidebar section, pushing away the matrix that actually matters. */
export type SetupGroup =
  'Collection' | 'MCP authentication' | 'Dependency analysis' | 'Global actions';

/** Icon names setupTreeProvider.ts maps to a ThemeIcon. */
export type SetupIcon =
  | 'pass' | 'warning' | 'circle-outline' | 'error' | 'circle-slash' | 'account' | 'lock' | 'unlock'
  | 'clock' | 'mortar-board';

export interface SetupRow {
  /** Absent means the row is not in any group: the tree renders it above every group header. */
  group?: SetupGroup;
  label: string;
  description: string;
  icon: SetupIcon;
  /** Command id run on click. Without it (undefined) clicking the row does nothing. */
  command?: string;
  /** Command arguments. Omitted, they default to `[{ serverName: label }]` (the server-row convention). */
  commandArgs?: unknown[];
  /** Hover description. Filled only for rows that do not fit on one line, such as collection status. */
  tooltip?: string;
  /** Icon accent colour (ThemeColor id). Default colour when absent. */
  colorId?: string;
  /** For view/item/context menu routing. */
  contextValue?: string;
  /** TreeItem id, distinguishing the same label across groups. Defaults to `group/label`. */
  id?: string;
}

export interface BuildSetupRowsInput {
  /** Every MCP server name obtained from collectAllSpecs(). */
  serverNames: string[];
  scanStatuses: ReadonlyMap<string, ServerScanStatus>;
  /** The mcpLens.authIgnore setting: servers whose login notification is permanently suppressed. */
  authIgnore: string[];
  /** The mcpLens.unsupportedServers setting: servers Lens does not support. */
  unsupported: string[];
  /** Servers that have definitions and for which findDependencyAnalysis returned a result. */
  analyzedServers: Set<string>;
  /** Servers with at least one tool definition: the denominator of the analysis group. */
  definitionServers: Set<string>;
  consent?: { provider: string; model: string };
  rollout: string;
  /** The mcpLens.walkthroughOpened flag in globalState: true once the walkthrough has been opened. */
  walkthroughOpened: boolean;
}

/**
 * Status colour has only three branches. A wall of grey icons makes it impossible to scan for the row that needs you.
 * DONE (blue): nothing left to do. It shares the colour of Healthy in the collection group so one view keeps one meaning.
 * TODO (yellow): not done yet, so the user has to press it.
 * BROKEN (red): attempted and failed.
 * Rows deliberately out of scope (ignored, not supported) get no colour: they are rows that must not draw the eye.
 */
const DONE = 'charts.blue';
const TODO = 'charts.yellow';
const BROKEN = 'charts.red';

function authRow(input: BuildSetupRowsInput, serverName: string): SetupRow {
  if (input.unsupported.includes(serverName)) {
    return { group: 'MCP authentication', label: serverName, description: 'not supported by Lens', icon: 'circle-slash' };
  }
  if (input.authIgnore.includes(serverName)) {
    // Ignoring is something the user chose and can undo at any time. Buried in grey, that server's
    // cost would keep going unmeasured unnoticed, so it stays red.
    // The row itself stays unclickable: an ignored server must not sign in by a stray click. Undoing
    // is done through the hover (inline) sign-in button this contextValue routes.
    return {
      group: 'MCP authentication', label: serverName, description: 'ignored', icon: 'circle-slash',
      colorId: BROKEN, contextValue: 'auth-ignored',
    };
  }
  const status = input.scanStatuses.get(serverName);
  if (!status) {
    return { group: 'MCP authentication', label: serverName, description: 'run a scan', icon: 'circle-outline', colorId: TODO, command: 'mcp-lens.scanNow' };
  }
  if (status.status === 'ok') {
    return { group: 'MCP authentication', label: serverName, description: 'authenticated', icon: 'pass', colorId: DONE };
  }
  if (status.status === 'auth-required') {
    return { group: 'MCP authentication', label: serverName, description: 'sign in to scan', icon: 'warning', colorId: TODO, command: 'mcp-lens.authenticateServer' };
  }
  // failed
  return {
    group: 'MCP authentication', label: serverName, description: status.errorCode ?? 'scan failed',
    icon: 'error', colorId: BROKEN, command: 'mcp-lens.scanNow',
  };
}

function providerRow(input: BuildSetupRowsInput): SetupRow {
  const description = input.consent ? `${input.consent.provider} · consented` : 'consent required';
  return {
    group: 'Dependency analysis', label: 'Provider', description, icon: 'account',
    colorId: input.consent ? DONE : TODO,
    command: 'mcplens.analyzeDependencies',
  };
}

function analysisRow(input: BuildSetupRowsInput, serverName: string): SetupRow {
  if (input.analyzedServers.has(serverName)) {
    return { group: 'Dependency analysis', label: serverName, description: 'analyzed', icon: 'pass', colorId: DONE };
  }
  return {
    group: 'Dependency analysis', label: serverName, description: 'not analyzed',
    icon: 'circle-outline', colorId: TODO, command: 'mcplens.reanalyzeServer',
  };
}

function globalActionsRow(input: BuildSetupRowsInput): SetupRow {
  const locked = input.rollout === 'off';
  return {
    group: 'Global actions', label: 'Global actions',
    description: locked ? 'locked' : `enabled (${input.rollout})`,
    icon: locked ? 'lock' : 'unlock',
    // Locked is not a fault, it is the default. It means something remains to be enabled, so it uses the TODO colour.
    colorId: locked ? TODO : DONE,
    command: 'mcp-lens.openRolloutSetting',
  };
}

/**
 * The entrance to the walkthrough, which is the only place that says what a scan costs and what the
 * hooks collect. It leads the view because a first-time user does not know the walkthrough exists and
 * so cannot find it in the command palette. It is dropped once the walkthrough has been opened: a
 * permanent row would spend a line forever on something read once and push the matrix further down.
 * The title-bar button stays regardless, so the walkthrough is never unreachable.
 */
function getStartedRow(): SetupRow {
  return {
    label: 'Get started', description: 'open the walkthrough', icon: 'mortar-board', colorId: TODO,
    command: 'mcp-lens.openWalkthrough',
    // Explicitly empty: the provider otherwise passes the server-row default of { serverName: label }.
    commandArgs: [],
    id: 'getStarted',
  };
}

/** Pure function with no vscode reference: it decides only which server is in which state. */
export function buildSetupRows(input: BuildSetupRowsInput): SetupRow[] {
  return [
    ...(input.walkthroughOpened ? [] : [getStartedRow()]),
    ...input.serverNames.map((name) => authRow(input, name)),
    providerRow(input),
    ...input.serverNames.filter((name) => input.definitionServers.has(name))
      .map((name) => analysisRow(input, name)),
    globalActionsRow(input),
  ];
}
