// packages/extension/src/autoScan.ts
import * as vscode from 'vscode';
import { watchFile, unwatchFile } from 'node:fs';
import {
  collectAllSpecs, configSources, scanServer, authenticateServer,
  type LensStore, type McpServerSpec, type ServerIdentity,
} from '@mcp-lens/core';
import { decideScanAction, type AutoScanSetting } from './scanDecision.js';
import { decideAuthPrompt, friendlyAuthError, isDcrRejected } from './authDecision.js';

/** Names of servers judged unsupported by Lens (stored permanently in settings). DCR-refusing servers and the like. */
const unsupportedServers = (config: vscode.WorkspaceConfiguration): string[] =>
  config.get<string[]>('unsupportedServers', []);

/**
 * Servers whose login notification was suppressed for this session with 'Later'.
 * Module scope, so it lives as long as the extension activation (= the VS Code window) and resets on
 * restart, satisfying "Later means no notification until VS Code restarts". (Permanent ignore is the authIgnore setting.)
 */
const sessionAuthSnooze = new Set<string>();

/**
 * Work that follows once a scan ingests new definitions. This is where the dependency analysis chains on.
 * It is not called when the scan succeeded for no server at all.
 */
export type AfterScan = () => void | Promise<void>;

async function runScan(store: LensStore, targets: McpServerSpec[],
  onDone: () => void, identities: readonly ServerIdentity[] = [],
  afterScan?: AfterScan): Promise<void> {
  let tools = 0, tokens = 0, failed: string[] = [], authFailed: McpServerSpec[] = [];
  for (const spec of targets) {
    const observedAt = new Date().toISOString();
    try {
      const result = await scanServer(spec);
      store.upsertScanResult(
        result.definitions,
        result.bodies,
        identities.filter((identity) => identity.serverName === spec.name),
      );
      store.recordServerScanStatus(spec.name, 'ok', observedAt);
      tools += result.definitions.length;
      tokens += result.definitions.reduce((s, d) => s + d.definitionTokens, 0);
    } catch (err) {
      failed.push(spec.name);
      const msg = err instanceof Error ? err.message : String(err);
      const needsAuth = msg.includes('auth-required') || msg.includes('token-expired');
      // errorCode is truncated to 120 characters because it lands in a tree row description.
      store.recordServerScanStatus(
        spec.name, needsAuth ? 'auth-required' : 'failed', observedAt,
        needsAuth ? undefined : msg.slice(0, 120));
      if (needsAuth) authFailed.push(spec);
    }
  }
  store.save();
  onDone(); // refresh(): update the ?tok figures in the status bar and sidebar
  const failNote = failed.length ? ` (failed: ${failed.join(', ')})` : '';
  vscode.window.setStatusBarMessage(
    `$(check) Lens: scanned ${targets.length - failed.length} servers, ${tools} tools, ${tokens}tok${failNote}`, 8000);
  if (authFailed.length) await maybeAuthPrompt(store, authFailed, onDone);
  // If not one server could be measured, there are no new definitions to analyze.
  if (afterScan && failed.length < targets.length) await afterScan();
}

/**
 * A scan the user explicitly requested. It runs even when the autoScan setting is 'never':
 * the setting means "do not do it automatically", not "do not do it when I press the button".
 */
export async function scanNow(store: LensStore, onDone: () => void, afterScan?: AfterScan): Promise<void> {
  const { specs, attribution, replaceable, identities } = collectAllSpecs();
  store.upsertClientServers(attribution, replaceable);
  const config = vscode.workspace.getConfiguration('mcpLens');
  const skip = new Set(unsupportedServers(config));
  const targets = specs.filter((s) => !skip.has(s.name));
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('MCP Lens: no MCP servers to scan.');
    return;
  }
  await runScan(store, targets, onDone, identities, afterScan);
}

/** After a scan, raises one login consent dialog for the servers that failed with auth-required/token-expired. */
export async function maybeAuthPrompt(
  store: LensStore, failedServers: McpServerSpec[], onDone: () => void,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('mcpLens');
  const ignoreList = config.get<string[]>('authIgnore', []);
  const action = decideAuthPrompt({
    failedServers, ignoreList,
    sessionSnoozed: [...sessionAuthSnooze], unsupported: unsupportedServers(config) });
  if (action.kind === 'skip') return;

  const names = action.targets.map((t) => t.name).join(', ');
  const pick = await vscode.window.showInformationMessage(
    `${action.targets.length} MCP server(s) (${names}) need sign-in. ` +
    `Sign in from your browser? (Lens will request access on your behalf.)`,
    'Sign in', 'Later', "Don't ask for this server");

  if (pick === 'Sign in') {
    const errors: string[] = [];
    const unsupported: string[] = [];
    for (const spec of action.targets) {
      const observedAt = new Date().toISOString();
      try {
        await authenticateServer(spec, {
          openUrl: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
        });
        const result = await scanServer(spec);
        store.upsertScanResult(result.definitions, result.bodies, []);
        // Apply the same classification as runScan here. Otherwise a successful login still leaves
        // Setup Status showing 'sign in to scan', and that state survives a restart.
        store.recordServerScanStatus(spec.name, 'ok', observedAt);
      } catch (err) {
        // A DCR-refusing server (Figma, say) fails before the browser even opens. Lens cannot support
        // it, so it is permanently recorded as an unsupported server, hidden from the tree and never asked about again.
        if (isDcrRejected(err)) {
          unsupported.push(spec.name);
        } else {
          errors.push(`${spec.name}: ${friendlyAuthError(err)}`); // surface the cause of any other failure
          // Same classification as runScan: auth-required/token-expired records a login-needed state, anything else records a failure.
          const msg = err instanceof Error ? err.message : String(err);
          const needsAuth = msg.includes('auth-required') || msg.includes('token-expired');
          store.recordServerScanStatus(
            spec.name, needsAuth ? 'auth-required' : 'failed', observedAt,
            needsAuth ? undefined : msg.slice(0, 120));
        }
      }
    }
    store.save();
    if (unsupported.length) {
      const merged = [...new Set([...unsupportedServers(config), ...unsupported])];
      await config.update('unsupportedServers', merged, vscode.ConfigurationTarget.Global);
      void vscode.window.showWarningMessage(
        `MCP Lens does not support the following MCP server(s): ${unsupported.join(', ')}`);
    }
    onDone(); // refresh the tree so the unsupported entry is hidden
    if (errors.length) void vscode.window.showErrorMessage(errors.join('\n'));
  } else if (pick === "Don't ask for this server") {
    const names2 = action.targets.map((t) => t.name);
    await config.update('authIgnore', [...ignoreList, ...names2], vscode.ConfigurationTarget.Global);
  } else if (pick === 'Later') {
    // Suppressed only for this VS Code session: a restart asks again.
    for (const t of action.targets) sessionAuthSnooze.add(t.name);
  } // dismissed (undefined): nothing is stored, so the next scan asks again
}

export async function maybeAutoScan(store: LensStore, onDone: () => void, afterScan?: AfterScan): Promise<void> {
  const { specs, attribution, replaceable, identities } = collectAllSpecs();
  // Attribution only needs the config files, so it is stored regardless of whether any server scan succeeded.
  // The mapping must be current even when the automatic scan is skipped (action.kind === 'skip').
  store.upsertClientServers(attribution, replaceable);
  store.save(); // run() does not save on its own. Without this save, the skip path (the default in a
                // settled state) never writes the mapping to disk and the next activation sees an empty mapping again.
  const config = vscode.workspace.getConfiguration('mcpLens');
  const setting = config.get<AutoScanSetting>('autoScan', 'never');
  const scannedServers = store.serversWithDefinitionBodies();
  const action = decideScanAction({
    setting, specs, scannedServers, unsupported: new Set(unsupportedServers(config)),
    neverScanned: store.allDefinitions().length === 0 });

  if (action.kind === 'skip') return;
  if (action.kind === 'scan') return runScan(store, action.targets, onDone, identities, afterScan);

  // kind === 'prompt': the agreed consent dialog
  const names = action.targets.map((t) => t.name).join(', ');
  const pick = await vscode.window.showInformationMessage(
    `MCP Lens: scan ${action.targets.length} MCP server(s) (${names}) for tool definitions? ` +
    `This briefly runs the server. No LLM tokens are spent and no config file is modified.`,
    'Scan', 'Later', "Don't ask again");
  if (pick === 'Scan') {
    await config.update('autoScan', 'always', vscode.ConfigurationTarget.Global);
    await runScan(store, action.targets, onDone, identities, afterScan);
  } else if (pick === "Don't ask again") {
    await config.update('autoScan', 'never', vscode.ConfigurationTarget.Global);
  } // 'Later' or dismissed: nothing is stored, so it asks again at the next startup
}

/** Watches every source config file (claude-user/project, codex, gemini) and re-decides after a debounce. Returns a dispose. */
export function watchConfigSources(store: LensStore, onDone: () => void, afterScan?: AfterScan): vscode.Disposable {
  const paths = configSources().map((s) => s.filePath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void maybeAutoScan(store, onDone, afterScan), 2000); // absorbs rapid saves
  };
  for (const p of paths) watchFile(p, { interval: 5000 }, listener);
  return {
    dispose: () => {
      clearTimeout(timer);
      for (const p of paths) unwatchFile(p, listener);
    },
  };
}
