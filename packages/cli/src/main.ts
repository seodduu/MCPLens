#!/usr/bin/env node
// packages/cli/src/main.ts
import { readFileSync } from 'node:fs';
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath,
  scanServer, ClaudeAdapter, CodexAdapter, GeminiAdapter,
  collectAllSpecs, configSources, collectFromSource,
  authenticateServer, clearStoredOAuth,
  type McpServerSpec, type ClientId, type ServerIdentity } from '@mcp-lens/core';
import { formatReport } from './report.js';
import { collectServerSpecs } from './scan-config.js';
import { scanFailureLine, formatSourceCounts } from './scan-report.js';
import { classifyScanFailure } from './scan-status.js';
import { openUrl } from './auth-open.js';
import { resolveAuthTarget } from './auth-target.js';
import { captureHook } from './hook-capture.js';
import {
  collectHookStatus,
  formatHookStatus,
  type HookClient,
} from './hooks-status.js';
import { diagnoseHooks, formatHookDiagnosis } from './hooks-doctor.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'report';
  if (cmd === 'scan') { await runScan(args); return; }
  if (cmd === 'auth') { await runAuth(args); return; }
  if (cmd === 'hooks') { await runHooks(args); return; }
  if (cmd === 'hook') { runHookCapture(args); return; }
  if (cmd !== 'report') {
    console.error(`unknown command: ${cmd} (expected 'report', 'scan', 'auth', 'hooks' or 'hook')`);
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
  const days = Number(argValue(args, '--days') ?? '30');
  const format = (argValue(args, '--format') ?? 'table') as 'table' | 'ai' | 'json';
  const store = await LensStore.open(dbPath());
  const watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]);
  const { files } = await watcher.backfill();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const input = {
    definitions: store.allDefinitions(),
    calls: store.callsSince(since),
    loads: store.loadsSince(since),
    sessions: store.sessionsSince(since),
    lastCallByTool: store.lastCallByTool(),
  };
  console.log(formatReport(buildMatrix(input), sessionSavings(input), format));
  console.error(`(${files} session files backfilled)`);
  store.close();
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
      console.log(`설정 파일을 찾을 수 없습니다: ${configPath}`);
      console.log('Claude Code에서 MCP 서버를 설정한 뒤 다시 시도하세요.');
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

  const store = await LensStore.open(dbPath());
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
    try {
      const result = await scanServer(spec);
      store.upsertScanResult(
        result.definitions,
        result.bodies,
        identities.filter((identity) => identity.serverName === spec.name),
      );
      store.recordServerScanStatus(spec.name, 'ok', scannedAt);
      const total = result.definitions.reduce((n, d) => n + d.definitionTokens, 0);
      console.log(`- ${spec.name}: ${result.definitions.length}개 툴, ${total} 토큰`);
    } catch (e) {
      const record = classifyScanFailure(e as Error);
      store.recordServerScanStatus(spec.name, record.status, scannedAt, record.errorCode);
      console.log(scanFailureLine(spec.name, e as Error));
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
    const msg = (e as Error).message;
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

  const store = await LensStore.open(dbPath());
  const scannedAt = new Date().toISOString();
  try {
    const result = await scanServer(target.spec);
    store.upsertScanResult(result.definitions, result.bodies, []);
    store.recordServerScanStatus(name, 'ok', scannedAt);
    const total = result.definitions.reduce((n, d) => n + d.definitionTokens, 0);
    console.log(`${name}: 로그인 완료, 툴 ${result.definitions.length}개 · ${total}토큰`);
    store.save();
  } catch (e) {
    const record = classifyScanFailure(e as Error);
    store.recordServerScanStatus(name, record.status, scannedAt, record.errorCode);
    console.log(scanFailureLine(name, e as Error));
  } finally {
    store.close();
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
