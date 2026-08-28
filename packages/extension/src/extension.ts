import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { LensStore, LogWatcher, dbPath, dbWriterLockPath,
  detectClients, ClaudeAdapter, CodexAdapter, GeminiAdapter,
  claudeSettingsPath, readDeniedMcpTools,
  defaultClaudeConfigPaths, listManagedServers, type ManagedServer,
  buildReport, renderReport, applyClaudeGlobalDeny, restoreClaudeGlobalDeny,
  applyCodexDisabledTool, restoreCodexDisabledTool, estimateInferenceCost, type ActionFileSystem,
  actionAllowedByRollout, migrateDependencyAnalysisRollout, DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT,
  type GlobalActionClient,
  type DependencyAnalysisRollout, collectAllSpecs } from '@mcp-lens/core';
import { WriterLeaseManager } from './writerLease.js';
import { chooseMode } from './leaseMode.js';
import { collectAction } from './pauseDecision.js';
import { formatStatus, wasteTooltip } from './statusBar.js';
import { buildTree } from './matrixTree.js';
import type { LensNode } from './matrixTree.js';
import { LensTreeProvider } from './lensTreeProvider.js';
import { maybeAutoScan, watchConfigSources } from './autoScan.js';
import { reportOptions } from './reportCommand.js';
import { collectionRows, toRow, type ClientRowInput } from './collectionRows.js';
import {
  ClaudeHookInstaller, type ClientHookInstaller, type HookClient, type InstallerDeps,
} from './hookInstall.js';
import { CodexHookInstaller } from './installers/codex.js';
import { GeminiHookInstaller } from './installers/gemini.js';
import { findBinary, runBin, nodeFs } from './claudeCli.js';
import { bundledStamp, installedStamp, needsRuntimeRefresh, recordInstalledStamp } from './runtimeFreshness.js';
import { claimFirstRun, WALKTHROUGH_CATEGORY_ID, WALKTHROUGH_OPENED_KEY } from './firstRun.js';
import { buildAnalysisRows } from './analysisTree.js';
import { buildAnalysisDetails } from './analysisDetails.js';
import { buildDisableConfirmation } from './disableConfirmation.js';
import { requestInferenceConsent, withdrawConsent } from './inferenceConsent.js';
import { readProviderConfig, resolveProvider, type ProviderResolution } from './providerConfig.js';
import { runInference } from './inferenceCli.js';
import { AnalysisCoordinator, ANALYSIS_RULES_VERSION, CONSENT_POLICY_VERSION } from './analysisCoordinator.js';
import { currentActionEligibility, disableGlobally, restoreGlobally, restoreRecommended } from './globalActionCommand.js';
import { registerScanNow, registerOpenRolloutSetting, registerAuthenticateServer } from './setupCommands.js';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_PROMPT_TITLE,
  AUTOMATION_SCAN_ONLY_LABEL, ensureAutomationConsent,
} from './automationConsent.js';
import { evaluateSetupKeys, stepsToUncheck, stepsToComplete, type SetupKeys } from './setupContextKeys.js';
import { buildSetupRows } from './setupTree.js';
import { SetupStatusProvider } from './setupTreeProvider.js';
import { applyCollectionResult } from './collectionRefresh.js';
import { noInstallTargetsMessage, installedSummaryMessage } from './installHooksAllMessage.js';
import { openStoreWithRecovery } from './storeOpen.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;
let lease: WriterLeaseManager | undefined;
let coordinator: IngestionCoordinatorLike | undefined;
let hooksPaused = false;

type IngestionCoordinatorLike = {
  drainInbox(): Promise<unknown>;
  startDraining(): Promise<void>;
  stopDraining(): Promise<void>;
  on(event: 'ingested' | 'receipt' | 'drain-error', listener: (arg?: unknown) => void): unknown;
  pause(): Promise<void>;
  resume(): void;
  readonly isPaused: boolean;
};

function coordinatorFor(store: LensStore): IngestionCoordinatorLike | undefined {
  const Constructor = (require('@mcp-lens/core') as {
    IngestionCoordinator?: new (options: { store: LensStore }) => IngestionCoordinatorLike;
  }).IngestionCoordinator;
  return Constructor ? new Constructor({ store }) : undefined;
}

export async function activate(ctx: vscode.ExtensionContext) {
  void vscode.commands.executeCommand('setContext', 'mcpLens.hooksPaused', false);
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Lens: starting…'; item.command = 'mcp-lens.showReport'; item.show();
  ctx.subscriptions.push(item);

  const treeProvider = new LensTreeProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.matrix', treeProvider));
  const setupStatusProvider = new SetupStatusProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.setupStatus', setupStatusProvider));


  function bundledDirFor(client: HookClient): string {
    return path.join(__dirname,
      client === 'claude-code' ? 'claude-marketplace'
      : client === 'codex' ? 'codex-marketplace' : 'gemini-extension');
  }

  const lensHomeDir = (): string => require('node:os').homedir() as string;

  /**
   * Silently reinstalls the hook runtime when the installed copy differs from the bundled one.
   *
   * The extension auto-updates, but the runtime copy is frozen at hook-installation time. When the
   * two diverge, collection breaks with no visible sign (measured: every tool-call envelope lost).
   * Users have no way to work that out themselves, so the extension detects it and reverts it.
   */
  async function refreshStaleRuntimes(inputs: ClientRowInput[]): Promise<boolean> {
    const home = lensHomeDir();
    let refreshed = false;
    for (const input of inputs) {
      const bundled = bundledStamp(nodeFs, bundledDirFor(input.client), input.client);
      if (!needsRuntimeRefresh(input.install, bundled, installedStamp(nodeFs, home, input.client))) continue;

      const installer = installerFor(input.client);
      await installer.uninstall();          // a failure is fine: install overwrites idempotently
      const result = await installer.install();
      if (result.kind === 'ok') {
        recordInstalledStamp(nodeFs, home, input.client, bundled!);
        refreshed = true;
        void vscode.window.showInformationMessage(
          `MCP Lens: ${input.client} hook runtime updated to the latest version. It applies starting with your next session.`);
      } else {
        void vscode.window.showWarningMessage(
          `MCP Lens: ${input.client} hook runtime is out of date. Collection may be inaccurate. Please remove and reinstall the hooks.`);
      }
    }
    return refreshed;
  }

  function installerFor(client: HookClient): ClientHookInstaller {
    const deps: InstallerDeps = {
      home: require('node:os').homedir(),
      findBinary,
      run: runBin,
      fs: nodeFs,
      bundledDir: bundledDirFor(client),
    };
    return client === 'claude-code' ? new ClaudeHookInstaller(deps)
      : client === 'codex' ? new CodexHookInstaller(deps)
      : new GeminiHookInstaller(deps);
  }

  let lastCollectionInputs: ClientRowInput[] = [];
  let collectionGeneration = 0;
  let runtimeChecked = false;

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.installHooks', async (node?: { client?: HookClient }) => {
      const client = node?.client; if (!client) return;
      const r = await installerFor(client).install();
      if (r.kind === 'client-missing') void vscode.window.showWarningMessage(`MCP Lens: could not find the ${client} CLI.`);
      else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} hook install failed (${r.step}): ${r.stderr.slice(0, 300)}`);
      else {
        const stamp = bundledStamp(nodeFs, bundledDirFor(client), client);
        if (stamp !== null) recordInstalledStamp(nodeFs, lensHomeDir(), client, stamp);
        void vscode.window.showInformationMessage(`MCP Lens: hooks installed for ${client}. Collection starts with your next session.`);
      }
      await computeCollection();
    }),
    vscode.commands.registerCommand('mcp-lens.uninstallHooks', async (node?: { client?: HookClient }) => {
      const client = node?.client; if (!client) return;
      const r = await installerFor(client).uninstall();
      if (r.kind === 'ok') void vscode.window.showInformationMessage(`MCP Lens: removed hooks for ${client}.`);
      else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} hook removal failed: ${r.stderr.slice(0, 300)}`);
      await computeCollection();
    }),
    // The "Install hooks" button of the onboarding walkthrough installs to every detected client at once.
    // No per-client notification: one walkthrough button press would otherwise raise up to three.
    vscode.commands.registerCommand('mcp-lens.installHooksAll', async () => {
      const inputs = await computeCollection();
      const targets = inputs.filter((input) => input.install === 'not-installed');
      if (targets.length === 0) {
        void vscode.window.showInformationMessage(noInstallTargetsMessage(inputs));
        return;
      }
      const installed: HookClient[] = [];
      let failedCount = 0;
      for (const input of targets) {
        const r = await installerFor(input.client).install();
        if (r.kind === 'ok') {
          const stamp = bundledStamp(nodeFs, bundledDirFor(input.client), input.client);
          if (stamp !== null) recordInstalledStamp(nodeFs, lensHomeDir(), input.client, stamp);
          installed.push(input.client);
        } else {
          failedCount++;
        }
      }
      void vscode.window.showInformationMessage(installedSummaryMessage(installed, failedCount));
      await computeCollection();
    }));

  // Global constraint 2: shared path. One corrupted DB must not kill the whole activation, so it goes through a recovery path.
  const opened = await openStoreWithRecovery(dbPath(), {
    open: (filePath) => LensStore.open(filePath),
    exists: (filePath) => fs.existsSync(filePath),
    rename: (from, to) => fs.renameSync(from, to),
    now: () => new Date(),
  });
  if (opened.kind === 'failed') {
    // Stopping here still ends activate successfully. The commands registered earlier stay alive,
    // and features that need data get guidance from the store guard.
    item.text = 'Lens: DB error';
    item.tooltip = opened.message;
    void vscode.window.showErrorMessage(opened.message);
    return;
  }
  store = opened.store;
  if (opened.kind === 'recovered') void vscode.window.showWarningMessage(opened.message);
  else if (opened.kind === 'degraded') void vscode.window.showErrorMessage(opened.message);
  coordinator = coordinatorFor(store);
  const active = detectClients().filter((c) => c.installed);
  watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]
      .filter((a) => active.some((c) => c.client === a.client)),
    { onReceipt: () => refresh() });

  const reportDays = () =>
    Math.max(1, vscode.workspace.getConfiguration('mcpLens').get<number>('reportDays', 30));
  const dependencyRollout = (): DependencyAnalysisRollout => {
    const configured = vscode.workspace.getConfiguration('mcplens')
      .get<unknown>('dependencyAnalysis.rollout');
    // Old values (shadow/codex-beta/stable) are left stored as they are and migrated only on read.
    return migrateDependencyAnalysisRollout(configured) ?? DEFAULT_DEPENDENCY_ANALYSIS_ROLLOUT;
  };
  const sinceIso = () => new Date(Date.now() - reportDays() * 86_400_000).toISOString();

  const readDeniedSafe = (): Set<string> => {
    try { return readDeniedMcpTools(claudeSettingsPath()); }
    catch { return new Set(); } // broken settings.json: keep displaying, report the error at write time
  };
  // When the whole table is empty (before a scan), pass undefined to turn filtering off.
  // When the table has rows but a client key is missing (gemini-cli with 0 servers, say),
  // pass it through so splitByClient filters that client down to zero definitions.
  const serversByClientOrUndefined = () => {
    const m = store!.serversByClient();
    return m.size > 0 ? m : undefined;
  };
  const configPaths = defaultClaudeConfigPaths();
  const listManagedSafe = (): ManagedServer[] => {
    try { return listManagedServers(configPaths); }
    catch { return []; } // collection failed: keep displaying
  };
  // Servers Lens does not support (DCR refusal and friends) are hidden from the tree.
  const unsupportedServers = (): Set<string> => new Set(
    vscode.workspace.getConfiguration('mcpLens').get<string[]>('unsupportedServers', []));

  let lastSetupKeys: SetupKeys | undefined;

  /** Names of servers that have definitions and for which findDependencyAnalysis returns a result. */
  function analyzedServerNames(s: LensStore): Set<string> {
    const serverNames = new Set(s.allDefinitions().map((definition) => definition.serverName));
    const analyzed = new Set<string>();
    for (const serverName of serverNames) {
      const body = s.definitionBodiesForServer(serverName)[0];
      if (body && s.findDependencyAnalysis(body.definitionSetHash, ANALYSIS_RULES_VERSION)) analyzed.add(serverName);
    }
    return analyzed;
  }
  const analyzedServerCount = (s: LensStore): number => analyzedServerNames(s).size;

  /** Refreshes the Setup Status view; computeCollection() calls it on every refresh cycle.
   * Collection state (the Collection group) is the first group of the same view, so it is filled here too. */
  function refreshSetupRows(inputs: ClientRowInput[]): void {
    const s = store!;
    const config = vscode.workspace.getConfiguration('mcpLens');
    const consent = s.currentInferenceConsent(CONSENT_POLICY_VERSION);
    const { specs } = collectAllSpecs();
    setupStatusProvider.setRows([...collectionRows(inputs), ...buildSetupRows({
      serverNames: specs.map((spec) => spec.name),
      scanStatuses: s.serverScanStatuses(),
      authIgnore: config.get<string[]>('authIgnore', []),
      unsupported: config.get<string[]>('unsupportedServers', []),
      analyzedServers: analyzedServerNames(s),
      definitionServers: new Set(s.allDefinitions().map((definition) => definition.serverName)),
      consent: consent?.status === 'accepted' ? { provider: consent.provider, model: consent.model } : undefined,
      rollout: dependencyRollout(),
      walkthroughOpened: ctx.globalState.get(WALKTHROUGH_OPENED_KEY) === true,
    })]);
  }

  async function refreshSetupKeys(inputs: ClientRowInput[]): Promise<void> {
    const s = store!;
    const next = evaluateSetupKeys({
      installs: inputs,
      definitionCount: s.allDefinitions().length,
      consentAccepted: s.currentInferenceConsent(CONSENT_POLICY_VERSION)?.status === 'accepted',
      analyzedServerCount: analyzedServerCount(s),
      rollout: dependencyRollout(),
    });
    for (const [key, value] of Object.entries(next)) {
      void vscode.commands.executeCommand('setContext', `mcpLens.${key}`, value);
    }
    for (const stepId of stepsToUncheck(lastSetupKeys, next)) {
      // An internal command. Its disappearance (or never finishing) must not block anything else.
      // The Setup Status view is the source of truth. Awaiting it would put this call inside the
      // collection-refresh critical section, where an unresponsive command could stall every
      void vscode.commands.executeCommand('welcome.markStepIncomplete', stepId).then(undefined, () => { /* ignored */ });
    }
    for (const stepId of stepsToComplete(lastSetupKeys, next)) {
      // The onContext event consumed by clearing (markStepIncomplete) cannot relight it, so it is set directly.
      // Fire-and-forget for the same reason: an internal command failure must not block refresh.
      void vscode.commands.executeCommand('welcome.markStepComplete', stepId).then(undefined, () => { /* ignored */ });
    }
    lastSetupKeys = next;
  }

  async function computeCollection(): Promise<ClientRowInput[]> {
    // The installHooks command is registered before the store is ready. Called very early in
    // activation, or after the DB failed to open, it must not die; it only reports guidance.
    if (!store) {
      void vscode.window.showInformationMessage(
        'MCP Lens: the database is still starting up. Try again in a moment.');
      return [];
    }
    const gen = ++collectionGeneration;
    const detected = detectClients().filter((c) => c.installed).map((c) => c.client);
    const byHealth = store!.collectionHealthByClient();
    const inputs = await Promise.all(detected.map(async (client) => ({
      client,
      install: await installerFor(client).detect(),
      snapshot: byHealth.get(client),
    })));
    await applyCollectionResult(gen, () => collectionGeneration, inputs, {
      applyInputs: (i) => { lastCollectionInputs = i; },
      refreshSetupKeys: (i) => refreshSetupKeys(i),
      refreshSetupRows: (i) => refreshSetupRows(i),
    });
    if (!runtimeChecked) {
      runtimeChecked = true;               // once per session: do not run the CLI on every refresh
      if (await refreshStaleRuntimes(inputs)) void computeCollection();
    }
    return inputs;
  }

  // Event-driven refreshes arrive at high frequency (coordinator, watcher, settings, file watcher),
  // while computeCollection() spawns a CLI subprocess per client (installerFor(...).detect()).
  // Without a guard, each event calling computeCollection() directly would flood the machine with
  // CLI processes and race over lastCollectionInputs and the Setup Status rows.
  // In-flight guard + trailing coalescing: while one runs, later requests only mark a pending flag,
  // and exactly one more run happens afterwards (not N queued runs, and not a lossless debounce).
  let collectionRefreshInFlight = false;
  let collectionRefreshPending = false;
  async function scheduleCollectionRefresh(): Promise<void> {
    if (collectionRefreshInFlight) { collectionRefreshPending = true; return; }
    collectionRefreshInFlight = true;
    try {
      await computeCollection();
    } finally {
      collectionRefreshInFlight = false;
      if (collectionRefreshPending) {
        collectionRefreshPending = false;
        void scheduleCollectionRefresh();
      }
    }
  }

  // One scan measures one server per name, so a name claimed by two clients with different endpoints
  // cannot have both measured. Its tokens are therefore not evidence about either client, and it is
  // kept out of the waste figure on the status bar and the report.
  const conflictedServerNames = (): Set<string> => new Set(
    store!.serverIdentities()
      .filter((identity) => identity.conflictState !== 'clear')
      .map((identity) => identity.serverName));

  const refresh = () => {
    const since = sinceIso();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since),
      lastCallByTool: store!.lastCallByTool(),
      serversByClient: serversByClientOrUndefined(),
      serverOverheads: store!.allServerContextOverheads(),
      scanStatuses: store!.serverScanStatuses() };
    // totals are unaffected by detail (tool list truncation), so minimal opts suffice.
    const totals = buildReport(input, {
      days: reportDays(), detail: 'summary', conflictedServers: conflictedServerNames(),
    }).totals;
    const wasteToolCount = totals.actToolCount + totals.candidateToolCount;
    const wasteTokens = totals.actPerSessionTokens + totals.candidatePerSessionTokens;
    item.text = formatStatus(wasteToolCount, wasteTokens);
    item.tooltip = wasteTooltip(wasteToolCount, wasteTokens);
    const analysisRows = store!.allDefinitions().flatMap((definition) => {
      const bodies = store!.definitionBodiesForServer(definition.serverName)
        .filter((body) => body.toolName === definition.toolName);
      const body = bodies[0];
      if (!body) return [];
      const identities = store!.serverIdentities(definition.serverName);
      if (identities.some((identity) => identity.conflictState !== 'clear')
        || new Set(identities.map((identity) => identity.endpointHash)).size > 1) {
        return buildAnalysisRows([], [{ serverName: definition.serverName, toolName: definition.toolName,
          state: 'Identity conflict', rationale: 'Server identity differs across client settings.' }]);
      }
      const analysis = store!.findDependencyAnalysis(body.definitionSetHash, ANALYSIS_RULES_VERSION);
      if (!analysis) return buildAnalysisRows([], [{ serverName: definition.serverName, toolName: definition.toolName,
        state: 'Not analyzed' }]);
      if (analysis.status === 'failed') return buildAnalysisRows([], [{ serverName: definition.serverName, toolName: definition.toolName,
        state: 'Analysis failed', rationale: analysis.errorCode ?? undefined }]);
      return buildAnalysisRows(analysis.results.map((result) => {
        const recommended = store!.activeActions().some((action) =>
          action.serverName === result.serverName && action.toolName === result.toolName
          && restoreRecommended(store!, action));
        return { ...result, displaySummary: recommended
          ? [result.displaySummary, 'Restore recommended'].filter(Boolean).join(' · ')
          : result.displaySummary };
      }));
    });
    treeProvider.setRoots(buildTree(
      input, readDeniedSafe(), listManagedSafe(), unsupportedServers(), analysisRows, dependencyRollout(),
      (client, serverName, toolName) => {
        if (client !== 'claude-code' && client !== 'codex') return false;
        const body = store!.definitionBodiesForServer(serverName)
          .find((row) => row.toolName === toolName);
        return body !== undefined && currentActionEligibility(store!, {
          client, serverName, toolName, definitionSetHash: body.definitionSetHash,
        }, ANALYSIS_RULES_VERSION).eligible;
      }, (client, serverName, toolName) => store!.activeActionFor(
        client as GlobalActionClient, serverName, toolName) !== null));
    void scheduleCollectionRefresh();
  };

  const actionFs: ActionFileSystem = {
    readFile: (filePath) => fs.promises.readFile(filePath, 'utf8'),
    writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8'),
    copyFile: (sourcePath, destinationPath) => fs.promises.copyFile(sourcePath, destinationPath),
    rename: (sourcePath, destinationPath) => fs.promises.rename(sourcePath, destinationPath),
    mkdir: (directoryPath) => fs.promises.mkdir(directoryPath, { recursive: true }).then(() => undefined),
    fsync: async (filePath) => { const handle = await fs.promises.open(filePath, 'r'); try { await handle.sync(); } finally { await handle.close(); } },
    listFiles: (directoryPath) => fs.promises.readdir(directoryPath).then((names) => names.map((name) => path.join(directoryPath, name))),
    remove: (filePath) => fs.promises.unlink(filePath),
  };

  let selectedProvider: { provider: 'claude' | 'codex'; model: string } | undefined;
  const providerResolution = (): ProviderResolution => {
    if (selectedProvider) return { kind: 'resolved', ...selectedProvider };
    return resolveProvider(readProviderConfig(vscode.workspace.getConfiguration('mcpLens')),
      { claude: findBinary('claude') !== null, codex: findBinary('codex') !== null });
  };
  const analysisCoordinator = new AnalysisCoordinator({
    store: () => store!, serverNames: () => [...new Set(store!.allDefinitions().map((row) => row.serverName))],
    resolve: providerResolution,
    run: async (request) => {
      const result = await runInference({
        provider: request.provider,
        model: request.model,
        batch: request.batch,
        signal: request.signal,
      });
      return result.ok ? { ok: true, value: result.value } : { ok: false, errorCode: result.errorCode };
    },
    requestConsent: async ({ provider, model }) => {
      const bodies = store!.allDefinitions().flatMap((definition) => store!.definitionBodiesForServer(definition.serverName));
      const estimate = estimateInferenceCost(provider, bodies.reduce((sum, body) => sum + body.definitionTokens, 0), bodies.length);
      const consent = await requestInferenceConsent(
        { provider, model, estimate },
        (title, options, acceptLabel) => vscode.window.showInformationMessage(title, options, acceptLabel),
        () => new Date().toISOString(),
      );
      if (!consent) return;
      store!.saveInferenceConsent(consent);
      store!.save();
      await analysisCoordinator.analyze();
    },
    onRefresh: refresh,
  });
  // Global constraint: the DB file can be shared by several extension instances (windows), so only
  // the one holding the lease acts as the writer (backfill, watcher, coordinator) and the rest wait
  // read-only (polling reload), promoting when the holder dies. §6.2.
  // LensStore.open() does not create ~/.mcplens until the first save(), so the directory is ensured
  // up front to let the lease file land before that.
  fs.mkdirSync(path.dirname(dbWriterLockPath()), { recursive: true });
  lease = new WriterLeaseManager(dbWriterLockPath());
  let mode = chooseMode(lease.tryAcquire());
  let roPoll: ReturnType<typeof setInterval> | undefined;
  let watcherStarted = false; // the watcher starts only through enterWriter, once per holder.
  let stopping: Promise<void> | undefined; // holds a watcher.stop() started by enterReadOnly that has not finished

  // The guard is installed as a last line of defence regardless of mode: if a non-holder attempts
  // save() through any path (a stray callback during a demotion race), StaleWriterError blocks it at once.
  store.setWriteGuard(() => lease!.isHolder());

  const isStaleWriterError = (e: unknown): boolean =>
    e instanceof Error && e.name === 'StaleWriterError';
  const ignoreStaleWriterError = (e: unknown) => {
    if (!isStaleWriterError(e)) console.error('MCP Lens: drain failed', e);
  };

  // Refresh listeners are registered once per activation, independent of writer/read-only switches.
  // Registering on every failover (each enterWriter call) would accumulate duplicate listeners.
  // refresh is read-only, and these emitters only fire while the writer path is alive.
  coordinator?.on('ingested', refresh);
  coordinator?.on('receipt', refresh);
  coordinator?.on('drain-error', ignoreStaleWriterError); // absorbs stray drains during a demotion race
  watcher!.on('ingested', refresh);

  function enterWriter() {
    mode = 'writer';
    if (roPoll) { clearInterval(roPoll); roPoll = undefined; }
    if (watcherStarted) return; // the writer path is already running for this holder: no double start
    const hookStep = collectAction(hooksPaused, 'writer') === 'start'
      ? (coordinator?.startDraining() ?? Promise.resolve())  // drain once immediately and keep watching pending
      : Promise.resolve();                                   // while paused, skip hook watching
    void hookStep
      .then(() => watcher!.backfill()) // catch up on the session backlog at start (feature 2); log backfill runs even while paused
      .then(() => { refresh(); })
      .catch(ignoreStaleWriterError);
    // If a watcher.stop() from the previous demotion is still closing, wait for it before start()
    // (LogWatcher.start() is not idempotent, so restarting mid-stop races).
    const pending = stopping;
    stopping = undefined;
    // State is re-checked only here: by the deferred run we may have been demoted again, and
    // setting watcherStarted must have a single point shared by the sync and deferred paths.
    const startWatcher = () => {
      if (mode !== 'writer' || watcherStarted) return;
      watcherStarted = true;
      watcher!.start();
    };
    if (pending) {
      void pending.catch(() => {}).then(startWatcher)
        .catch((e) => console.error('MCP Lens: watcher restart failed', e));
    } else startWatcher();
    lease!.startHeartbeat(() => enterReadOnly()); // a failed renew demotes
  }

  function enterReadOnly() {
    mode = 'read-only';
    watcherStarted = false;
    stopping = watcher?.stop(); // stop the write path by stopping the watcher. The coordinator drain is not called.
    void coordinator?.stopDraining().catch(() => {}); // stop watching pending (an in-flight drain finishes on its own)
    let lastMtime = 0;
    if (!roPoll) roPoll = setInterval(() => {
      let acquired = false;
      try {
        const m = fs.statSync(dbPath()).mtimeMs;
        if (m !== lastMtime) { lastMtime = m; store!.reload(); refresh(); }
        // acquire can throw on a lock-file permission problem and the like. It stays inside this try
        // so no unhandled exception fires every 4 seconds. The promotion itself happens outside the catch.
        acquired = lease!.tryAcquire();
      } catch { /* missing file or transient error, ignored */ }
      if (acquired) enterWriter(); // the holder died, so promote
    }, 4_000);
  }

  if (mode === 'writer') enterWriter(); else { enterReadOnly(); refresh(); }

  ctx.subscriptions.push({ dispose: () => { if (roPoll) clearInterval(roPoll); lease?.stop(); } });

  /**
   * The one path to the walkthrough: first activation, the Get started row and the title-bar button all
   * come through here. Opening it marks the flag, which is what drops the Get started row.
   * The failure is logged instead of swallowed. A silent catch meant a walkthrough that never appeared
   * left no trace at all, and finding out why took reading VS Code's own state database.
   */
  async function openWalkthrough(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_CATEGORY_ID);
    } catch (error) {
      // Never block activation: the Setup Status view is the source of truth for what is left to do.
      console.error('[mcp-lens] could not open the walkthrough', error);
    }
    await ctx.globalState.update(WALKTHROUGH_OPENED_KEY, true);
    void computeCollection();
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.openWalkthrough', () => openWalkthrough()));

  // Only the focused window may claim the first run. globalState is shared across windows while the
  // extension host is per window, so without this guard whichever window activates first claims the flag
  // and opens the walkthrough in itself. With several windows open that is usually not the one the user
  // is looking at, and the walkthrough appears to have silently never opened.
  if (vscode.window.state.focused && await claimFirstRun(ctx.globalState)) void openWalkthrough();

  // Hook installation and approval prompts are never raised as notification popups. Back-to-back
  // popups right after install, before the user did anything, hurt the first impression. The Setup
  // Status view always shows the same content as rows (not-installed and awaiting-approval states
  // with run buttons), and step 2 of the walkthrough explains it.
  // The login-required notification (maybeAuthPrompt) stays: it is the result of a scan the user
  void computeCollection();

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mcpLens.reportDays') ||
        e.affectsConfiguration('mcpLens.unsupportedServers') ||
        // Setting that turns globalActionsReady of step 4 on and off. refresh() flows through
        // scheduleCollectionRefresh() to computeCollection() and refreshSetupKeys().
        e.affectsConfiguration('mcplens.dependencyAnalysis.rollout')) refresh();
  }));

  /**
   * Once a scan ingests new definitions, the independence analysis follows. A scan alone answers
   * "how much"; the analysis answers "can it be turned off". The user needs both to act.
   *
   * It does use the provider CLI's tokens, so mcpLens.autoAnalyze can turn it off, and
   * already-analyzed tools are never resent.
   *
   * A user who answered the automatic scan prompt before finishing onboarding never saw the
   * automation consent modal, so autoAnalyze stays unwritten and analysis would be skipped in
   * silence. Ask here instead: a new server has just been scanned, which is the moment the tokens
   * would be spent. An explicit false is respected without asking again.
   */
  const analyzeAfterScan = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('mcpLens');
    const consented = await ensureAutomationConsent(
      config,
      () => vscode.window.showInformationMessage(
        AUTOMATION_PROMPT_TITLE,
        { modal: true, detail: AUTOMATION_PROMPT_DETAIL },
        AUTOMATION_ACCEPT_LABEL, AUTOMATION_SCAN_ONLY_LABEL),
      vscode.ConfigurationTarget.Global);
    if (!consented) return;
    await analysisCoordinator.analyze([], { auto: true });
  };

  void maybeAutoScan(store, refresh, analyzeAfterScan);                     // decide once at startup
  ctx.subscriptions.push(watchConfigSources(store, refresh, analyzeAfterScan)); // then watch the config files
  ctx.subscriptions.push(
    // A manual scan never chains into analysis. This command is the step 1 button of the
    // walkthrough, and pressing it would silently finish step 3 (analysis) and spend the user's
    // tokens. On a screen that shows four steps in order, a step 1 that also does step 3 leaves the
    // remaining steps meaningless. Automatic analysis follows only on the path that detected a new server and scanned it itself.
    registerScanNow(() => store!, refresh),
    registerOpenRolloutSetting(), registerAuthenticateServer(refresh));

  const requestAnalysis = async (node?: LensNode, reanalyze = false) => {
    selectedProvider = undefined;
    const resolution = providerResolution();
    if (resolution.kind === 'unavailable') {
      void vscode.window.showErrorMessage('No supported inference provider is available.');
      return;
    }
    if (resolution.kind === 'choose') {
      const pick = await vscode.window.showInformationMessage('Choose a provider for dependency analysis.', 'Claude', 'Codex');
      if (!pick) return;
      const config = readProviderConfig(vscode.workspace.getConfiguration('mcpLens'));
      selectedProvider = pick === 'Claude' ? { provider: 'claude', model: config.claudeModel } : { provider: 'codex', model: config.codexModel };
    }
    await analysisCoordinator.analyze(reanalyze && node?.serverName ? [node.serverName] : []);
    selectedProvider = undefined;
  };
  const openAnalysisDetails = async (node?: LensNode) => {
    if (!node?.serverName || !node.toolName) return;
    const body = store!.definitionBodiesForServer(node.serverName).find((row) => row.toolName === node.toolName);
    const result = body && store!.findDependencyAnalysis(body.definitionSetHash, ANALYSIS_RULES_VERSION)?.results
      .find((row) => row.serverName === node.serverName && row.toolName === node.toolName);
    if (!result) { void vscode.window.showInformationMessage('This tool has not been analyzed yet.'); return; }
    const details = buildAnalysisDetails(result, JSON.stringify(body));
    const content = [`# ${details.title}`, ...details.sections.map((section) => `## ${section.label}\n${section.value}`), ...details.notices].join('\n\n');
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  };
  const actionClient = (node: LensNode): GlobalActionClient | undefined => node.client === 'claude-code' || node.client === 'codex' ? node.client : undefined;
  const settingsPathFor = (client: GlobalActionClient): string => client === 'claude-code' ? claudeSettingsPath() : path.join(os.homedir(), '.codex', 'config.toml');
  const disable = async (node?: LensNode) => {
    if (!node?.canDisableGlobally || !node.serverName || !node.toolName) return;
    const client = actionClient(node); const body = store!.definitionBodiesForServer(node.serverName).find((row) => row.toolName === node.toolName);
    if (!client || !body) return;
    // Show what will be lost first and get a human confirmation. The restore path has no such step.
    const analysisResult = store!.findDependencyAnalysis(body.definitionSetHash, ANALYSIS_RULES_VERSION)?.results
      .find((row) => row.serverName === node.serverName && row.toolName === node.toolName);
    if (!analysisResult) { void vscode.window.showInformationMessage('This tool has not been analyzed yet.'); return; }
    const confirmation = buildDisableConfirmation(analysisResult);
    const answer = await vscode.window.showWarningMessage(
      confirmation.message, { modal: true, detail: confirmation.detail }, confirmation.confirmLabel);
    if (answer !== confirmation.confirmLabel) return;
    const rolloutAllowed = actionAllowedByRollout(dependencyRollout(), client);
    const result = await disableGlobally({ store: store!, target: { client, serverName: node.serverName, toolName: node.toolName, definitionSetHash: body.definitionSetHash },
      rolloutAllowed, analysisRulesVersion: ANALYSIS_RULES_VERSION,
      apply: () => client === 'claude-code' ? applyClaudeGlobalDeny({ serverName: node.serverName!, toolName: node.toolName!, settingsPath: settingsPathFor(client), actions: store!.activeActions() }, actionFs) : applyCodexDisabledTool({ serverName: node.serverName!, toolName: node.toolName!, settingsPath: settingsPathFor(client), actions: store!.activeActions() }, actionFs), refresh });
    if (result.ok) void vscode.window.showInformationMessage('Global action applied. It takes effect in new sessions.'); else void vscode.window.showErrorMessage(result.message);
  };
  const restore = async (node?: LensNode) => {
    const client = node ? actionClient(node) : undefined;
    if (!client || !node?.serverName || !node.toolName) return;
    const action = store!.activeActionFor(client, node.serverName, node.toolName); if (!action) return;
    const result = await restoreGlobally({ store: store!, action,
      rolloutAllowed: actionAllowedByRollout(dependencyRollout(), client),
      restore: () => client === 'claude-code' ? restoreClaudeGlobalDeny(action, actionFs) : restoreCodexDisabledTool(action, actionFs) });
    if (result.ok) { refresh(); void vscode.window.showInformationMessage('Global action restored.'); } else void vscode.window.showErrorMessage(result.message);
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcplens.openAnalysisDetails', openAnalysisDetails),
    vscode.commands.registerCommand('mcplens.analyzeDependencies', () => requestAnalysis()),
    vscode.commands.registerCommand('mcplens.reanalyzeServer', (node: LensNode) => requestAnalysis(node, true)),
    vscode.commands.registerCommand('mcplens.disableGlobally', disable),
    vscode.commands.registerCommand('mcplens.restoreGlobally', restore),
    vscode.commands.registerCommand('mcplens.withdrawInferenceConsent', () => {
      const consent = store!.currentInferenceConsent(CONSENT_POLICY_VERSION); if (!consent || consent.status !== 'accepted') return;
      store!.saveInferenceConsent(withdrawConsent(consent, new Date().toISOString())); store!.save();
      void vscode.window.showInformationMessage('Inference consent withdrawn. Cached analyses and global actions were kept.');
    }));

  // Legacy IDs remain callable for compatibility but must use the v2 guarded path.
  const legacyRemoveTool = async (node?: LensNode) => {
    if (node?.kind !== 'tool' || node.client !== 'claude-code') {
      void vscode.window.showErrorMessage('This legacy command only supports Claude Code tools.');
      return;
    }
    await disable(node);
  };
  const legacyAddTool = async (node?: LensNode) => {
    if (node?.kind !== 'tool' || node.client !== 'claude-code') {
      void vscode.window.showErrorMessage('This legacy command only supports Claude Code tools.');
      return;
    }
    await restore(node);
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.removeTool', legacyRemoveTool),
    vscode.commands.registerCommand('mcp-lens.addTool', legacyAddTool));

  const rejectLegacyServerAction = () => {
    void vscode.window.showErrorMessage('Server-wide global actions are not supported.');
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.removeServer', rejectLegacyServerAction),
    vscode.commands.registerCommand('mcp-lens.addServer', rejectLegacyServerAction));

  const watchFile = (absPath: string) => {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(absPath)), path.basename(absPath)));
    w.onDidChange(refresh); w.onDidCreate(refresh); w.onDidDelete(refresh);
    ctx.subscriptions.push(w);
  };
  watchFile(configPaths.claudeJsonPath); // ~/.claude.json
  watchFile(configPaths.stashPath);      // ~/.mcplens/disabled-servers.json

  const settingsDir = vscode.Uri.file(path.dirname(claudeSettingsPath()));
  const settingsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(settingsDir, 'settings.json'));
  settingsWatcher.onDidChange(refresh);
  settingsWatcher.onDidCreate(refresh);
  settingsWatcher.onDidDelete(refresh);
  ctx.subscriptions.push(settingsWatcher);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.showReport', () => {
      const since = sinceIso();
      const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since),
        lastCallByTool: store!.lastCallByTool(),
        serversByClient: serversByClientOrUndefined(),
        serverOverheads: store!.allServerContextOverheads(),
      scanStatuses: store!.serverScanStatuses() };
      const opts = reportOptions({
        reportDays: vscode.workspace.getConfiguration('mcpLens').get<number>('reportDays', 30),
        reportDetail: vscode.workspace.getConfiguration('mcpLens').get<'summary' | 'full'>('reportDetail'),
      });
      const doc = renderReport(buildReport(input, { ...opts, conflictedServers: conflictedServerNames() }), opts);
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }),
    vscode.commands.registerCommand('mcp-lens.hooksDoctor', (client?: HookClient) => {
      if (lastCollectionInputs.length === 0) {
        void vscode.window.showInformationMessage('MCP Lens: collection status is not known yet (no clients detected).');
        return;
      }
      if (client) {
        const found = lastCollectionInputs.find((i) => i.client === client);
        if (!found) {
          void vscode.window.showInformationMessage(`MCP Lens: ${client} status is not known yet.`);
          return;
        }
        const row = toRow(found);
        void vscode.window.showInformationMessage(`MCP Lens collection status (${client}): ${row.description}`);
        return;
      }
      const summary = lastCollectionInputs.map((i) => `${i.client}: ${toRow(i).description}`).join(' / ');
      void vscode.window.showInformationMessage(`MCP Lens collection status: ${summary}`);
    }),
    vscode.commands.registerCommand('mcp-lens.hooksPause', async () => {
      if (!coordinator) {
        void vscode.window.showWarningMessage('MCP Lens: cannot pause because the collector has not been initialized.');
        return;
      }
      hooksPaused = true;
      await coordinator.pause();
      void vscode.commands.executeCommand('setContext', 'mcpLens.hooksPaused', true);
      void vscode.window.showInformationMessage(
        'MCP Lens: hook collection is paused. Hooks that fire while paused are held and applied on resume. ' +
        'Resume happens automatically when VS Code restarts.');
    }),
    vscode.commands.registerCommand('mcp-lens.hooksResume', async () => {
      if (!coordinator) return;
      hooksPaused = false;
      coordinator.resume();
      void vscode.commands.executeCommand('setContext', 'mcpLens.hooksPaused', false);
      if (collectAction(hooksPaused, mode) === 'start') {
        await coordinator.startDraining().catch(ignoreStaleWriterError);
      }
      void vscode.window.showInformationMessage('MCP Lens: hook collection resumed.');
    }));
}

export async function deactivate() {
  await watcher?.stop();
  // Leave no pending-watch interval behind. This is the process shutdown path, but the cleanup order is explicit.
  await coordinator?.stopDraining().catch(() => {});
  try { store?.save(); }
  catch (e) {
    // read-only (non-holder) instances are correctly blocked from save() (StaleWriterError): ignored.
    if (!(e instanceof Error) || e.name !== 'StaleWriterError') throw e;
  }
  store?.close();
}
