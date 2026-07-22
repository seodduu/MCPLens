import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { LensStore, LogWatcher, dbPath, dbWriterLockPath,
  detectClients, ClaudeAdapter, CodexAdapter, GeminiAdapter,
  claudeSettingsPath, readDeniedMcpTools, denyMcpTool, allowMcpTool,
  defaultClaudeConfigPaths, listManagedServers, disableServer, enableServer, type ManagedServer,
  buildReport, renderReport } from '@mcp-lens/core';
import { WriterLeaseManager } from './writerLease.js';
import { chooseMode } from './leaseMode.js';
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
import { pendingHookClients } from './nudge.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;
let lease: WriterLeaseManager | undefined;

type IngestionCoordinatorLike = {
  drainInbox(): Promise<unknown>;
  on(event: 'ingested' | 'receipt', listener: () => void): unknown;
  pause?: () => void | Promise<void>;
};

function coordinatorFor(store: LensStore): IngestionCoordinatorLike | undefined {
  const Constructor = (require('@mcp-lens/core') as {
    IngestionCoordinator?: new (options: { store: LensStore }) => IngestionCoordinatorLike;
  }).IngestionCoordinator;
  return Constructor ? new Constructor({ store }) : undefined;
}

export async function activate(ctx: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Lens: starting…'; item.command = 'mcp-lens.showReport'; item.show();
  ctx.subscriptions.push(item);

  const treeProvider = new LensTreeProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.matrix', treeProvider));
  const hookStatusProvider = new HookStatusProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mcpLens.collection', hookStatusProvider));

  const DISMISS_KEY = 'mcpLens.hookInstall.dismissed';

  function installerFor(client: HookClient): ClientHookInstaller {
    const deps: InstallerDeps = {
      home: require('node:os').homedir(),
      findBinary,
      run: runBin,
      fs: nodeFs,
      bundledDir: path.join(__dirname,
        client === 'claude-code' ? 'claude-marketplace'
        : client === 'codex' ? 'codex-marketplace' : 'gemini-extension'),
    };
    return client === 'claude-code' ? new ClaudeHookInstaller(deps)
      : client === 'codex' ? new CodexHookInstaller(deps)
      : new GeminiHookInstaller(deps);
  }

  let lastCollectionInputs: ClientRowInput[] = [];
  let collectionGeneration = 0;

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.installHooks', async (node?: { client?: HookClient }) => {
      const client = node?.client; if (!client) return;
      const r = await installerFor(client).install();
      if (r.kind === 'client-missing') void vscode.window.showWarningMessage(`MCP Lens: ${client} CLI를 찾을 수 없습니다.`);
      else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} 훅 설치 실패 (${r.step}): ${r.stderr.slice(0, 300)}`);
      else void vscode.window.showInformationMessage(`MCP Lens: ${client} 훅 설치 완료 — 새 세션부터 수집이 시작됩니다.`);
      await computeCollection();
    }),
    vscode.commands.registerCommand('mcp-lens.uninstallHooks', async (node?: { client?: HookClient }) => {
      const client = node?.client; if (!client) return;
      const r = await installerFor(client).uninstall();
      if (r.kind === 'ok') void vscode.window.showInformationMessage(`MCP Lens: ${client} 훅을 제거했습니다.`);
      else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} 훅 제거 실패: ${r.stderr.slice(0, 300)}`);
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
    treeProvider.setRoots(buildTree(input, readDeniedSafe(), listManagedSafe(), unsupportedServers()));
    void scheduleCollectionRefresh();
  };
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
  watcher!.on('ingested', refresh);

  function enterWriter() {
    mode = 'writer';
    if (roPoll) { clearInterval(roPoll); roPoll = undefined; }
    if (watcherStarted) return; // 이미 이 홀더로 writer 경로가 구동 중 — 중복 시작 방지
    watcherStarted = true;
    void coordinator?.drainInbox()
      .then(() => watcher!.backfill()) // 시작 시 밀린 세션 따라잡기 (기능 2)
      .then(() => { refresh(); })
      .catch(ignoreStaleWriterError);
    // 직전 강등에서 시작한 watcher.stop()이 아직 닫히는 중이면, 새 start() 전에 끝나길 기다린다
    // (LogWatcher.start()가 비멱등이라 stop 도중 재시작하면 경합이 생긴다).
    const pending = stopping;
    stopping = undefined;
    const startWatcher = () => watcher!.start();
    if (pending) void pending.catch(() => {}).then(startWatcher);
    else startWatcher();
    lease!.startHeartbeat(() => enterReadOnly()); // renew 실패 → 강등
  }

  function enterReadOnly() {
    mode = 'read-only';
    watcherStarted = false;
    stopping = watcher?.stop(); // 쓰기 경로 정지: 워처를 멈춘다. 코디네이터 drain은 호출하지 않는다.
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
    const inputs = await computeCollection();
    const detected = new Set(inputs.map((i) => i.client));
    const states = new Map(inputs.map((i) => [i.client, i.install] as const));
    const dismissed = new Set<HookClient>(
      (['claude-code', 'codex', 'gemini-cli'] as HookClient[])
        .filter((c) => ctx.globalState.get<boolean>(`${DISMISS_KEY}.${c}`)));
    const pending = pendingHookClients(detected, states, dismissed);
    if (pending.length === 0) return;
    const choice = await vscode.window.showInformationMessage(
      `MCP Lens: ${pending.join('·')} 훅 수집이 꺼져 있어요`, '모두 설치', '수집 뷰 열기', '다시 안 보기');
    if (choice === '모두 설치') { for (const c of pending) await installerFor(c).install(); await computeCollection(); }
    else if (choice === '수집 뷰 열기') void vscode.commands.executeCommand('mcpLens.collection.focus');
    else if (choice === '다시 안 보기') for (const c of pending) await ctx.globalState.update(`${DISMISS_KEY}.${c}`, true);
  })();

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mcpLens.reportDays') ||
        e.affectsConfiguration('mcpLens.unsupportedServers')) refresh();
  }));

  void maybeAutoScan(store, refresh);                     // 시작 시 1회 판정
  ctx.subscriptions.push(watchConfigSources(store, refresh)); // 이후 설정 파일 감시

  // deny 토글: settings.json이 원본 — 커맨드는 파일만 수정, 워처가 트리에 반영
  const toggleTool = (node: LensNode, action: 'deny' | 'allow') => {
    if (!node?.serverName || !node.toolName) return;
    try {
      if (action === 'deny') {
        denyMcpTool(claudeSettingsPath(), node.serverName, node.toolName);
        void vscode.window.showInformationMessage(
          `${node.serverName}/${node.toolName} 차단됨 — 새 Claude Code 세션부터 적용됩니다.`);
      } else {
        allowMcpTool(claudeSettingsPath(), node.serverName, node.toolName);
        void vscode.window.showInformationMessage(
          `${node.serverName}/${node.toolName} 차단 해제됨 — 새 Claude Code 세션부터 적용됩니다.`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        `settings.json을 수정하지 못했습니다 (파일은 변경되지 않음): ${e instanceof Error ? e.message : String(e)}`);
    }
    refresh();
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.removeTool', (n: LensNode) => toggleTool(n, 'deny')),
    vscode.commands.registerCommand('mcp-lens.addTool', (n: LensNode) => toggleTool(n, 'allow')));

  // 서버 단위 토글: 설정 파일들이 원본 — 커맨드는 파일만 수정, 워처가 트리에 반영
  const toggleServer = async (node: LensNode, action: 'disable' | 'enable') => {
    if (node?.kind !== 'server' || !node.serverName) return;
    try {
      if (action === 'disable') {
        const pick = await vscode.window.showWarningMessage(
          `${node.serverName} 서버를 Claude Code에서 차단할까요? 서버 연결과 툴 정의 로드가 모두 중단됩니다.`,
          { modal: true }, '차단');
        if (pick !== '차단') return;
        disableServer(configPaths, node.serverName);
        void vscode.window.showInformationMessage(
          `${node.serverName} 서버 차단됨 — 새 Claude Code 세션부터 적용됩니다.`);
      } else {
        enableServer(configPaths, node.serverName);
        void vscode.window.showInformationMessage(
          `${node.serverName} 서버 차단 해제됨 — 새 Claude Code 세션부터 적용됩니다.`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        `서버 설정을 수정하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    refresh();
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.removeServer', (n: LensNode) => toggleServer(n, 'disable')),
    vscode.commands.registerCommand('mcp-lens.addServer', (n: LensNode) => toggleServer(n, 'enable')));

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
      if (coordinator?.pause) {
        await coordinator.pause();
        void vscode.window.showInformationMessage('MCP Lens Hook 수집을 일시 중지했습니다.');
      } else {
        void vscode.window.showWarningMessage(
          '이 버전에서는 Hook 수집을 확장에서 일시 중지할 수 없습니다. 클라이언트의 Hook 또는 플러그인을 비활성화하세요.');
      }
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
