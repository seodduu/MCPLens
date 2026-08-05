#!/usr/bin/env node
// packages/cli/src/main.ts
import { readFileSync } from 'node:fs';
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath,
  ClaudeAdapter, CodexAdapter, GeminiAdapter,
  collectAllSpecs, configSources, collectFromSource,
  authenticateServer, clearStoredOAuth,
  type McpServerSpec, type ClientId, type ServerIdentity } from '@mcp-lens/core';
import { formatReport } from './report.js';
import { collectServerSpecs } from './scan-config.js';
import { formatSourceCounts } from './scan-report.js';
import { scanOneServer } from './scan-run.js';
import { runAuthRescan } from './auth-rescan.js';
import { openUrl } from './auth-open.js';
import { resolveAuthTarget } from './auth-target.js';
import { captureHook } from './hook-capture.js';
import {
  collectHookStatus,
  formatHookStatus,
  type HookClient,
} from './hooks-status.js';
import { diagnoseHooks, formatHookDiagnosis } from './hooks-doctor.js';
import { HELP_TEXT, isHelpRequest } from './help.js';
import { parseDays, parseFormat } from './args.js';
import { acquireWriterLease, withWriterLease, type WriterLeaseHandle } from './writer-lease.js';

async function main() {
  const args = process.argv.slice(2);
  if (isHelpRequest(args)) { process.stdout.write(HELP_TEXT); return; }
  const cmd = args[0] ?? 'report';
  if (cmd === 'scan') { await runScan(args); return; }
  if (cmd === 'auth') { await runAuth(args); return; }
  if (cmd === 'hooks') { await runHooks(args); return; }
  if (cmd === 'hook') { runHookCapture(args); return; }
  if (cmd !== 'report') {
    console.error(`알 수 없는 커맨드: ${cmd}\n`);
    console.error(HELP_TEXT);
    process.exit(1);
  }
  await runReport(args);
}

async function runHooks(args: string[]) {
  const subcommand = args[1] ?? 'status';
  const statuses = collectHookStatus();
  if (subcommand === 'status') {
    process.stdout.write(formatHookStatus(statuses, args.includes('--json')));
    return;
  }
  if (subcommand === 'doctor') {
    const requestedClient = args[2];
    if (requestedClient !== undefined && !isHookClient(requestedClient)) {
      console.error(`unknown hook client: ${requestedClient}`);
      process.exit(1);
      return;
    }
    process.stdout.write(formatHookDiagnosis(diagnoseHooks(statuses, requestedClient)));
    return;
  }
  console.error(`unknown hooks command: ${subcommand} (expected 'status' or 'doctor')`);
  process.exit(1);
}

function runHookCapture(args: string[]) {
  if (args[1] !== 'capture') {
    console.error(`unknown hook command: ${args[1] ?? ''} (expected 'capture')`);
    process.exit(1);
    return;
  }
  const client = argValue(args, '--client');
  // Read the hook payload once even for an invalid command, then preserve the
  // fail-open stdout contract required by lifecycle hook hosts.
  const stdin = readFileSync(0, 'utf8');
  if (!isHookClient(client)) {
    console.error('hook capture requires --client claude-code|codex|gemini-cli');
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(captureHook(client, stdin, new Date()).stdout);
}

function isHookClient(value: string | undefined): value is HookClient {
  return value === 'claude-code' || value === 'codex' || value === 'gemini-cli';
}

async function runReport(args: string[]) {
  const days = parseDays(argValue(args, '--days'));
  if (!days.ok) { console.error(days.message); process.exit(1); return; }
  const format = parseFormat(argValue(args, '--format'));
  if (!format.ok) { console.error(format.message); process.exit(1); return; }

  // report는 읽기 커맨드지만 backfill이 관측을 적재하며 save()를 한다. 리스를 잡으면
  // 그 적재분을 디스크에 남기고, 확장이 홀더라 못 잡으면 write guard를 비홀더로 걸어
  // 저장만 건너뛴다. 메모리에 적재된 관측은 그대로 이번 리포트에 반영되므로 결과는 같다.
  const acquired = acquireWriterLease();
  const lease: WriterLeaseHandle | null = acquired.ok ? acquired.lease : null;
  try {
    const store = await LensStore.open(dbPath());
    store.setWriteGuard(() => lease !== null && lease.isHolder());
    let files = 0;
    try {
      ({ files } = await watcherFor(store).backfill());
    } catch (e) {
      if (!isStaleWriterError(e)) throw e;
      console.error('(다른 프로세스가 DB를 쓰는 중이라 이번 실행은 읽기 전용으로 진행합니다)');
    }
    const since = new Date(Date.now() - days.value * 86_400_000).toISOString();
    const input = {
      definitions: store.allDefinitions(),
      calls: store.callsSince(since),
      loads: store.loadsSince(since),
      sessions: store.sessionsSince(since),
      lastCallByTool: store.lastCallByTool(),
    };
    console.log(formatReport(buildMatrix(input), sessionSavings(input), format.value));
    console.error(`(${files} session files backfilled)`);
    store.close();
  } finally {
    lease?.release();
  }
}

function watcherFor(store: LensStore): LogWatcher {
  return new LogWatcher(store, [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]);
}

/** 비홀더가 save()를 시도했을 때 core가 던지는 가드 예외. 이름으로만 판별한다(클래스 비공개). */
function isStaleWriterError(e: unknown): boolean {
  return e instanceof Error && e.name === 'StaleWriterError';
}

/** configSources() 각 파일을 읽어 소스 종류별 발견 스펙 수를 센다 (읽기 전용). */
function sourceDiscoveryCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of configSources()) {
    let text: string;
    try {
      text = readFileSync(source.filePath, 'utf8');
    } catch {
      continue;
    }
    const { specs } = collectFromSource(source.kind, text);
    counts[source.kind] = (counts[source.kind] ?? 0) + specs.length;
  }
  return counts;
}

async function runScan(args: string[]) {
  const configPath = argValue(args, '--config');
  let specs: McpServerSpec[];
  let skipped: string[];
  let attribution: Map<string, Set<ClientId>> | undefined;
  let replaceable: Set<ClientId> | undefined;
  let identities: ServerIdentity[] = [];

  if (configPath) {
    let jsonText: string;
    try {
      jsonText = readFileSync(configPath, 'utf8');
    } catch {
      // 사용자가 명시한 경로가 없는 것은 실패다. 스크립트가 감지할 수 있게 exit 1로 끝낸다
      // (설정 파일을 지정하지 않은 전체 스캔에서 서버가 0개인 것과는 다른 상황이다).
      console.error(`설정 파일을 찾을 수 없습니다: ${configPath}`);
      console.error('경로를 확인하거나, --config 없이 실행해 감지된 설정을 모두 읽게 하세요.');
      process.exit(1);
      return;
    }
    ({ specs, skipped } = collectServerSpecs(jsonText));
  } else {
    const result = collectAllSpecs();
    specs = result.specs;
    skipped = result.skipped;
    attribution = result.attribution;
    replaceable = result.replaceable;
    identities = result.identities;
    const summary = formatSourceCounts(sourceDiscoveryCounts());
    if (summary) console.log(`발견: ${summary}`);
  }

  for (const name of skipped)
    console.log(`- ${name}: stdio 서버가 아니어서 건너뜀 (command 필드 없음)`);
  // --config 단일 파일 스캔에서 서버가 0개면 여기서 끝 — 매핑을 건드리지 않는다
  // (전체 소스를 관찰하지 않았으므로 attribution이 애초에 undefined).
  if (specs.length === 0 && attribution === undefined) {
    console.log('스캔할 MCP 서버가 없습니다.');
    return;
  }

  // 여기서부터 DB에 쓴다. 리스 없이 열면 open 이후 확장이 적재한 관측이 save()에서 통째로
  // 덮여 사라진다. 설정 읽기·경로 검증은 위에서 이미 끝냈으므로 락은 필요한 구간만 쥔다.
  const written = await withWriterLease((lease) =>
    scanIntoStore(specs, attribution, replaceable, identities, lease));
  if (!written.ok) { console.error(written.message); process.exit(1); }
}

/** 스캔 결과를 DB에 적재한다. writer lease를 쥔 상태에서만 호출한다. */
async function scanIntoStore(
  specs: McpServerSpec[],
  attribution: Map<string, Set<ClientId>> | undefined,
  replaceable: Set<ClientId> | undefined,
  identities: ServerIdentity[],
  lease: WriterLeaseHandle,
): Promise<void> {
  const store = await LensStore.open(dbPath());
  // 리스를 잃으면(확장에 인수당함) save가 StaleWriterError로 막힌다. 남의 관측을 덮는 것보다
  // 이번 스캔 결과를 버리는 쪽이 낫다.
  store.setWriteGuard(() => lease.isHolder());
  // --config 단일 파일 스캔에서는 undefined — 전체 소스를 관찰하지 않았으므로
  // 교체하면 다른 클라이언트의 매핑이 잘못 지워진다.
  if (attribution !== undefined && replaceable !== undefined)
    store.upsertClientServers(attribution, replaceable);
  if (specs.length === 0) {
    // 전체 스캔 경로에서 서버가 0개 — 매핑은 위에서 이미 갱신(비움)했다. 스캔할 것만 없다.
    console.log('스캔할 MCP 서버가 없습니다.');
    store.save();
    store.close();
    return;
  }
  for (const spec of specs) {
    const scannedAt = new Date().toISOString();
    const result = await scanOneServer(store, spec, scannedAt, identities);
    if (result.ok) {
      console.log(`- ${spec.name}: ${result.toolCount}개 툴, ${result.totalTokens} 토큰`);
    } else {
      console.log(result.line);
    }
  }
  store.save();
  store.close();
}

/** `mcp-lens auth <serverName> [--clear]` — http 서버 OAuth 로그인 후 즉시 1개 서버만 스캔·적재. */
async function runAuth(args: string[]) {
  const rest = args.slice(1);
  const clear = rest.includes('--clear');
  const name = rest.find((a) => !a.startsWith('--'));

  if (!name) {
    console.log('사용법: mcp-lens auth <serverName> [--clear]');
    process.exit(1);
    return;
  }

  if (clear) {
    clearStoredOAuth(name);
    console.log(`${name}: 저장된 인증 정보를 삭제했습니다.`);
    return;
  }

  const { specs } = collectAllSpecs();
  const target = resolveAuthTarget(specs, name);
  if (!target.ok) {
    console.log(target.message);
    process.exit(1);
    return;
  }

  try {
    await authenticateServer(target.spec, { openUrl });
  } catch (e) {
    // authenticateServer가 SDK 예외를 그대로 재던질 수 있어 Error가 아닌 값도 들어온다.
    // (e as Error).message로 단정하면 이 catch 블록 안에서 TypeError가 나
    // DCR 안내 메시지 대신 처리되지 않은 크래시가 사용자에게 노출된다.
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${name}: 로그인 실패 — ${msg}`);
    if (/dynamic client registration/i.test(msg)) {
      console.log(
        `  이 서버는 동적 클라이언트 등록(DCR)을 지원하지 않습니다 (예: GitHub 원격 MCP).\n` +
        `  대신 설정의 headers 필드에 PAT를 넣으면 스캔됩니다:\n` +
        `  "${name}": { "type": "http", "url": "...", "headers": { "Authorization": "Bearer <토큰>" } }`);
    }
    process.exit(1);
    return;
  }

  // 리스는 DB를 여는 직전에만 잡는다. 브라우저 로그인은 사용자가 얼마든지 붙잡고 있을 수
  // 있어서, 그 시간까지 락을 쥐면 확장이 그동안 아무것도 저장하지 못한다.
  const rescan = await withWriterLease(async (lease) => {
    const store = await LensStore.open(dbPath());
    store.setWriteGuard(() => lease.isHolder());
    const scannedAt = new Date().toISOString();
    await runAuthRescan(store, target.spec, scannedAt);
  });
  if (!rescan.ok) {
    console.error(`${name}: 로그인은 끝났지만 결과를 저장하지 못했습니다.`);
    console.error(rescan.message);
    process.exit(1);
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
