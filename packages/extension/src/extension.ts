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
  actionAllowedByRollout, isDependencyAnalysisRollout, type GlobalActionClient,
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
import { HookStatusProvider, toRow, type ClientRowInput } from './hookStatusProvider.js';
import {
  ClaudeHookInstaller, type ClientHookInstaller, type HookClient, type InstallerDeps,
} from './hookInstall.js';
import { CodexHookInstaller } from './installers/codex.js';
import { GeminiHookInstaller } from './installers/gemini.js';
import { findBinary, runBin, nodeFs } from './claudeCli.js';
import { bundledStamp, installedStamp, needsRuntimeRefresh, recordInstalledStamp } from './runtimeFreshness.js';
import { approvalPendingClients, pendingHookClients } from './nudge.js';
import { buildAnalysisRows } from './analysisTree.js';
import { buildAnalysisDetails } from './analysisDetails.js';
import { requestInferenceConsent, withdrawConsent } from './inferenceConsent.js';
import { readProviderConfig, resolveProvider, type ProviderResolution } from './providerConfig.js';
import { runInference } from './inferenceCli.js';
import { AnalysisCoordinator, ANALYSIS_RULES_VERSION, CONSENT_POLICY_VERSION } from './analysisCoordinator.js';
import { currentActionEligibility, disableGlobally, restoreGlobally, restoreRecommended } from './globalActionCommand.js';
import { registerScanNow, registerOpenRolloutSetting, registerAuthenticateServer } from './setupCommands.js';
import { evaluateSetupKeys, stepsToUncheck, type SetupKeys } from './setupContextKeys.js';
import { buildSetupRows } from './setupTree.js';
import { SetupStatusProvider } from './setupTreeProvider.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;
let lease: WriterLeaseManager | undefined;
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
  const hookStatusProvider = new HookStatusProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.collection', hookStatusProvider));
  const setupStatusProvider = new SetupStatusProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.setupStatus', setupStatusProvider));

  const DISMISS_KEY = 'mcpLens.hookInstall.dismissed';

  function bundledDirFor(client: HookClient): string {
    return path.join(__dirname,
      client === 'claude-code' ? 'claude-marketplace'
      : client === 'codex' ? 'codex-marketplace' : 'gemini-extension');
  }

  const lensHomeDir = (): string => require('node:os').homedir() as string;

  /**
   * 설치된 훅 런타임이 번들과 다르면 조용히 재설치한다.
   *
   * 확장은 자동 업데이트되지만 런타임 사본은 훅 설치 시점에 고정된다. 둘이
   * 어긋나면 수집이 아무 표시 없이 망가진다(실측: 툴 호출 봉투 전량 유실).
   * 사용자가 스스로 알아낼 방법이 없으므로 확장이 감지해 되돌린다.
   */
  async function refreshStaleRuntimes(inputs: ClientRowInput[]): Promise<boolean> {
    const home = lensHomeDir();
    let refreshed = false;
    for (const input of inputs) {
      const bundled = bundledStamp(nodeFs, bundledDirFor(input.client), input.client);
      if (!needsRuntimeRefresh(input.install, bundled, installedStamp(nodeFs, home, input.client))) continue;

      const installer = installerFor(input.client);
      await installer.uninstall();          // 실패해도 install이 멱등하게 덮는다
      const result = await installer.install();
      if (result.kind === 'ok') {
        recordInstalledStamp(nodeFs, home, input.client, bundled!);
        refreshed = true;
        void vscode.window.showInformationMessage(
          `MCP Lens: ${input.client} 훅 런타임을 최신으로 갱신했습니다 — 새 세션부터 적용됩니다.`);
      } else {
        void vscode.window.showWarningMessage(
          `MCP Lens: ${input.client} 훅 런타임이 낡았습니다. 수집이 부정확할 수 있으니 훅을 제거 후 다시 설치해 주세요.`);
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
      if (r.kind === 'client-missing') void vscode.window.showWarningMessage(`MCP Lens: ${client} CLI를 찾을 수 없습니다.`);
      else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} 훅 설치 실패 (${r.step}): ${r.stderr.slice(0, 300)}`);
      else {
        const stamp = bundledStamp(nodeFs, bundledDirFor(client), client);
        if (stamp !== null) recordInstalledStamp(nodeFs, lensHomeDir(), client, stamp);
        void vscode.window.showInformationMessage(`MCP Lens: ${client} 훅 설치 완료 — 새 세션부터 수집이 시작됩니다.`);
      }
      await computeCollection();
    }),
    vscode.commands.registerCommand('mcp-lens.uninstallHooks', async (node?: { client?: HookClient }) => {
      const client = node?.client; if (!client) return;
      const r = await installerFor(client).uninstall();
      if (r.kind === 'ok') void vscode.window.showInformationMessage(`MCP Lens: ${client} 훅을 제거했습니다.`);
      else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} 훅 제거 실패: ${r.stderr.slice(0, 300)}`);
      await computeCollection();
    }),
    // 온보딩 워크스루의 "Install hooks" 버튼: 감지된 클라이언트 전부에 한 번에 설치한다.
    // 개별 클라이언트마다 알림을 띄우지 않는 이유는 워크스루 버튼 한 번에 최대 3개가 뜨기 때문이다.
    vscode.commands.registerCommand('mcp-lens.installHooksAll', async () => {
      const inputs = await computeCollection();
      const targets = inputs.filter((input) => input.install === 'not-installed');
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('MCP Lens: hooks are already installed.');
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
      const failedNote = failedCount > 0 ? ` ${failedCount} failed.` : '';
      void vscode.window.showInformationMessage(
        `MCP Lens: installed hooks for ${installed.join(', ')}.${failedNote}`);
      await computeCollection();
    }));

  store = await LensStore.open(dbPath()); // 전역 제약 2: 공유 경로
  const coordinator = coordinatorFor(store);
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
    return isDependencyAnalysisRollout(configured) ? configured : 'shadow';
  };
  const sinceIso = () => new Date(Date.now() - reportDays() * 86_400_000).toISOString();

  const readDeniedSafe = (): Set<string> => {
    try { return readDeniedMcpTools(claudeSettingsPath()); }
    catch { return new Set(); } // 깨진 settings.json — 표시는 계속, 쓰기 시점에 에러 안내
  };
  // 표 전체가 비어 있으면(스캔 전) undefined를 넘겨 필터링을 끈다.
  // 표에 행이 있는데 특정 클라이언트 키만 없는 경우(예: gemini-cli 서버 0개)는
  // 그대로 넘겨 splitByClient가 그 클라이언트를 정의 0개로 걸러내게 한다.
  const serversByClientOrUndefined = () => {
    const m = store!.serversByClient();
    return m.size > 0 ? m : undefined;
  };
  const configPaths = defaultClaudeConfigPaths();
  const listManagedSafe = (): ManagedServer[] => {
    try { return listManagedServers(configPaths); }
    catch { return []; } // 수집 실패 — 표시는 계속
  };
  // Lens가 지원하지 않는 서버(DCR 거부 등) — 트리에서 숨긴다.
  const unsupportedServers = (): Set<string> => new Set(
    vscode.workspace.getConfiguration('mcpLens').get<string[]>('unsupportedServers', []));

  let lastSetupKeys: SetupKeys | undefined;

  /** 정의가 있는 서버 중 findDependencyAnalysis가 결과를 주는 서버 이름 집합. */
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

  /** Setup Status 뷰 갱신 — computeCollection()이 매 refresh 사이클마다 함께 부른다. */
  function refreshSetupRows(): void {
    const s = store!;
    const config = vscode.workspace.getConfiguration('mcpLens');
    const consent = s.currentInferenceConsent(CONSENT_POLICY_VERSION);
    const { specs } = collectAllSpecs();
    setupStatusProvider.setRows(buildSetupRows({
      serverNames: specs.map((spec) => spec.name),
      scanStatuses: s.serverScanStatuses(),
      authIgnore: config.get<string[]>('authIgnore', []),
      unsupported: config.get<string[]>('unsupportedServers', []),
      analyzedServers: analyzedServerNames(s),
      definitionServers: new Set(s.allDefinitions().map((definition) => definition.serverName)),
      consent: consent?.status === 'accepted' ? { provider: consent.provider, model: consent.model } : undefined,
      rollout: dependencyRollout(),
    }));
  }

  async function refreshSetupKeys(inputs: ClientRowInput[]): Promise<void> {
    const s = store!;
    const next = evaluateSetupKeys({
      installs: inputs,
      definitionCount: s.allDefinitions().length,
      consentAccepted: s.currentInferenceConsent(CONSENT_POLICY_VERSION)?.status === 'accepted',
      analyzedServerCount: analyzedServerCount(s),
    });
    for (const [key, value] of Object.entries(next)) {
      void vscode.commands.executeCommand('setContext', `mcpLens.${key}`, value);
    }
    for (const stepId of stepsToUncheck(lastSetupKeys, next)) {
      try {
        // 내부 커맨드다. 사라져도 나머지 동작을 막지 않는다 — 진실은 Setup Status 뷰다.
        await vscode.commands.executeCommand('welcome.markStepIncomplete', stepId);
      } catch { /* 무시 */ }
    }
    lastSetupKeys = next;
  }

  async function computeCollection(): Promise<ClientRowInput[]> {
    const gen = ++collectionGeneration;
    const detected = detectClients().filter((c) => c.installed).map((c) => c.client);
    const byHealth = store!.collectionHealthByClient();
    const inputs = await Promise.all(detected.map(async (client) => ({
      client,
      install: await installerFor(client).detect(),
      snapshot: byHealth.get(client),
    })));
    if (gen === collectionGeneration) {
      lastCollectionInputs = inputs;
      hookStatusProvider.setClients(inputs);
    }
    if (!runtimeChecked) {
      runtimeChecked = true;               // 세션당 1회 — 매 refresh마다 CLI를 돌리지 않는다
      if (await refreshStaleRuntimes(inputs)) void computeCollection();
    }
    await refreshSetupKeys(inputs);
    refreshSetupRows();
    return inputs;
  }

  // 이벤트 유발 refresh는 고빈도(코디네이터/워처/설정/파일워처)로 몰려 들어올 수 있는데,
  // computeCollection()은 클라이언트마다 CLI 서브프로세스를 스폰한다(installerFor(...).detect()).
  // 가드 없이 각 이벤트가 computeCollection()을 직접 부르면 CLI 프로세스 폭주와
  // lastCollectionInputs/hookStatusProvider에 대한 경쟁이 발생한다.
  // 인플라이트 가드 + 트레일링 코얼레싱: 실행 중이면 대기만 표시하고,
  // 끝난 뒤 대기가 있었으면 정확히 한 번 더 실행한다(N개 큐잉 아님, 유실 없는 debounce도 아님).
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

  const refresh = () => {
    const since = sinceIso();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since),
      lastCallByTool: store!.lastCallByTool(),
      serversByClient: serversByClientOrUndefined() };
    // totals는 detail(툴 목록 절단)에 영향받지 않으므로 최소 opts로 충분.
    const totals = buildReport(input, { days: reportDays(), detail: 'summary' }).totals;
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
  // 전역 제약: DB 파일은 여러 확장 인스턴스(창)가 공유할 수 있으므로,
  // 리스를 획득한 하나만 writer(백필/워처/코디네이터 구동)로 동작하고 나머지는
  // read-only(폴링 reload)로 대기하다 홀더가 죽으면 승격한다. §6.2.
  // LensStore.open()은 최초 save() 전까지 ~/.mcplens를 만들지 않으므로,
  // 리스 파일을 그보다 먼저 놓을 수 있게 디렉터리를 미리 보장한다.
  fs.mkdirSync(path.dirname(dbWriterLockPath()), { recursive: true });
  lease = new WriterLeaseManager(dbWriterLockPath());
  let mode = chooseMode(lease.tryAcquire());
  let roPoll: ReturnType<typeof setInterval> | undefined;
  let watcherStarted = false; // 워처는 오직 enterWriter를 통해서만, 홀더당 한 번만 시작한다.
  let stopping: Promise<void> | undefined; // enterReadOnly가 시작한 watcher.stop()이 아직 안 끝났으면 보관

  // 모드와 무관하게 최후 방어선으로 가드를 걸어 둔다: 비홀더가 어떤 경로로든
  // save()를 시도하면(예: 강등 경합 중 남은 콜백) StaleWriterError로 즉시 차단된다.
  store.setWriteGuard(() => lease!.isHolder());

  const isStaleWriterError = (e: unknown): boolean =>
    e instanceof Error && e.name === 'StaleWriterError';
  const ignoreStaleWriterError = (e: unknown) => {
    if (!isStaleWriterError(e)) console.error('MCP Lens: drain failed', e);
  };

  // writer/read-only 전환과 무관하게 refresh 리스너는 activation당 한 번만 등록한다.
  // 반복되는 failover(enterWriter 재호출)마다 등록하면 중복 리스너가 누적된다.
  // refresh는 읽기 전용이고, 이 이미터들은 writer 경로가 살아있을 때만 이벤트를 낸다.
  coordinator?.on('ingested', refresh);
  coordinator?.on('receipt', refresh);
  coordinator?.on('drain-error', ignoreStaleWriterError); // 강등 경합 중 stray drain 흡수
  watcher!.on('ingested', refresh);

  function enterWriter() {
    mode = 'writer';
    if (roPoll) { clearInterval(roPoll); roPoll = undefined; }
    if (watcherStarted) return; // 이미 이 홀더로 writer 경로가 구동 중 — 중복 시작 방지
    const hookStep = collectAction(hooksPaused, 'writer') === 'start'
      ? (coordinator?.startDraining() ?? Promise.resolve())  // 즉시 1회 drain + pending 상시 감시
      : Promise.resolve();                                   // 중지 중이면 훅 감시는 건너뛴다
    void hookStep
      .then(() => watcher!.backfill()) // 시작 시 밀린 세션 따라잡기 (기능 2), 중지 중에도 로그 백필은 돈다
      .then(() => { refresh(); })
      .catch(ignoreStaleWriterError);
    // 직전 강등에서 시작한 watcher.stop()이 아직 닫히는 중이면, 새 start() 전에 끝나길 기다린다
    // (LogWatcher.start()가 비멱등이라 stop 도중 재시작하면 경합이 생긴다).
    const pending = stopping;
    stopping = undefined;
    // 상태 재확인은 여기서만: 지연 실행 시점엔 이미 재강등되어 있을 수 있고,
    // watcherStarted 설정도 sync/deferred 두 경로가 공유하는 단일 지점이어야 한다.
    const startWatcher = () => {
      if (mode !== 'writer' || watcherStarted) return;
      watcherStarted = true;
      watcher!.start();
    };
    if (pending) {
      void pending.catch(() => {}).then(startWatcher)
        .catch((e) => console.error('MCP Lens: watcher restart failed', e));
    } else startWatcher();
    lease!.startHeartbeat(() => enterReadOnly()); // renew 실패 → 강등
  }

  function enterReadOnly() {
    mode = 'read-only';
    watcherStarted = false;
    stopping = watcher?.stop(); // 쓰기 경로 정지: 워처를 멈춘다. 코디네이터 drain은 호출하지 않는다.
    void coordinator?.stopDraining().catch(() => {}); // pending 감시 중지(인플라이트 drain은 자연 종료)
    let lastMtime = 0;
    if (!roPoll) roPoll = setInterval(() => {
      try {
        const m = fs.statSync(dbPath()).mtimeMs;
        if (m !== lastMtime) { lastMtime = m; store!.reload(); refresh(); }
      } catch { /* 파일 없음/일시 오류 무시 */ }
      if (lease!.tryAcquire()) enterWriter(); // 홀더가 죽었으면 승격
    }, 4_000);
  }

  if (mode === 'writer') enterWriter(); else { enterReadOnly(); refresh(); }

  ctx.subscriptions.push({ dispose: () => { if (roPoll) clearInterval(roPoll); lease?.stop(); } });

  void (async () => {
    const dismissed = new Set<HookClient>(
      (['claude-code', 'codex', 'gemini-cli'] as HookClient[])
        .filter((c) => ctx.globalState.get<boolean>(`${DISMISS_KEY}.${c}`)));

    const announce = async (): Promise<void> => {
      const inputs = await computeCollection();
      const detected = new Set(inputs.map((i) => i.client));
      const states = new Map(inputs.map((i) => [i.client, i.install] as const));
      const awaiting = approvalPendingClients(detected, states, dismissed);
      if (awaiting.length === 0) return;
      const pick = await vscode.window.showWarningMessage(
        `MCP Lens: ${awaiting.join('·')} 훅을 켰습니다. codex를 한 번 실행해 뜨는 동의를 승인하면 수집이 시작됩니다.`,
        '수집 뷰 열기', '다시 안 보기');
      if (pick === '수집 뷰 열기') void vscode.commands.executeCommand('mcpLens.collection.focus');
      else if (pick === '다시 안 보기') {
        for (const c of awaiting) await ctx.globalState.update(`${DISMISS_KEY}.${c}`, true);
      }
    };

    const inputs = await computeCollection();
    const detected = new Set(inputs.map((i) => i.client));
    const states = new Map(inputs.map((i) => [i.client, i.install] as const));
    const pending = pendingHookClients(detected, states, dismissed);
    if (pending.length === 0) { await announce(); return; }

    const choice = await vscode.window.showInformationMessage(
      `MCP Lens: ${pending.join('·')} 훅 수집이 꺼져 있어요`, '모두 설치', '수집 뷰 열기', '다시 안 보기');
    if (choice === '모두 설치') {
      for (const c of pending) await installerFor(c).install();
      await announce();                       // 설치로 needs-approval이 됐는지 다시 본다
    } else if (choice === '수집 뷰 열기') {
      void vscode.commands.executeCommand('mcpLens.collection.focus');
    } else if (choice === '다시 안 보기') {
      for (const c of pending) await ctx.globalState.update(`${DISMISS_KEY}.${c}`, true);
    }
  })();

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mcpLens.reportDays') ||
        e.affectsConfiguration('mcpLens.unsupportedServers')) refresh();
  }));

  void maybeAutoScan(store, refresh);                     // 시작 시 1회 판정
  ctx.subscriptions.push(watchConfigSources(store, refresh)); // 이후 설정 파일 감시
  ctx.subscriptions.push(
    registerScanNow(() => store!, refresh), registerOpenRolloutSetting(), registerAuthenticateServer(refresh));

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
        serversByClient: serversByClientOrUndefined() };
      const opts = reportOptions({
        reportDays: vscode.workspace.getConfiguration('mcpLens').get<number>('reportDays', 30),
        reportDetail: vscode.workspace.getConfiguration('mcpLens').get<'summary' | 'full'>('reportDetail'),
      });
      const doc = renderReport(buildReport(input, opts), opts);
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }),
    vscode.commands.registerCommand('mcp-lens.hooksDoctor', (client?: HookClient) => {
      if (lastCollectionInputs.length === 0) {
        void vscode.window.showInformationMessage('MCP Lens: 아직 수집 상태를 알 수 없습니다 (감지된 클라이언트 없음).');
        return;
      }
      if (client) {
        const found = lastCollectionInputs.find((i) => i.client === client);
        if (!found) {
          void vscode.window.showInformationMessage(`MCP Lens: ${client} 상태를 아직 알 수 없습니다.`);
          return;
        }
        const row = toRow(found);
        void vscode.window.showInformationMessage(`MCP Lens 수집 상태 (${client}): ${row.description}`);
        return;
      }
      const summary = lastCollectionInputs.map((i) => `${i.client}: ${toRow(i).description}`).join(' / ');
      void vscode.window.showInformationMessage(`MCP Lens 수집 상태 — ${summary}`);
    }),
    vscode.commands.registerCommand('mcp-lens.hooksPause', async () => {
      if (!coordinator) {
        void vscode.window.showWarningMessage('MCP Lens: 수집기가 초기화되지 않아 중지할 수 없습니다.');
        return;
      }
      hooksPaused = true;
      await coordinator.pause();
      void vscode.commands.executeCommand('setContext', 'mcpLens.hooksPaused', true);
      void vscode.window.showInformationMessage(
        'MCP Lens: Hook 수집을 일시 중지했습니다. 중지 중 발생한 훅은 보관되었다가 재개 시 반영됩니다 (VS Code 재시작 시 자동 재개).');
    }),
    vscode.commands.registerCommand('mcp-lens.hooksResume', async () => {
      if (!coordinator) return;
      hooksPaused = false;
      coordinator.resume();
      void vscode.commands.executeCommand('setContext', 'mcpLens.hooksPaused', false);
      if (collectAction(hooksPaused, mode) === 'start') {
        await coordinator.startDraining().catch(ignoreStaleWriterError);
      }
      void vscode.window.showInformationMessage('MCP Lens: Hook 수집을 재개했습니다.');
    }));
}

export async function deactivate() {
  await watcher?.stop();
  try { store?.save(); }
  catch (e) {
    // read-only(비홀더)는 정상적으로 save()가 차단된다(StaleWriterError) — 무시.
    if (!(e instanceof Error) || e.name !== 'StaleWriterError') throw e;
  }
  store?.close();
}
