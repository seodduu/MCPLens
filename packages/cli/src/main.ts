#!/usr/bin/env node
// packages/cli/src/main.ts
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath,
  scanServer, ClaudeAdapter, CodexAdapter, GeminiAdapter } from '@mcp-lens/core';
import { formatReport } from './report.js';
import { collectServerSpecs } from './scan-config.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'report';
  if (cmd === 'scan') { await runScan(args); return; }
  if (cmd !== 'report') {
    console.error(`unknown command: ${cmd} (expected 'report' or 'scan')`);
    process.exit(1);
  }
  await runReport(args);
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
  };
  console.log(formatReport(buildMatrix(input), sessionSavings(input), format));
  console.error(`(${files} session files backfilled)`);
  store.close();
}

async function runScan(args: string[]) {
  const configPath = argValue(args, '--config') ?? path.join(os.homedir(), '.claude.json');
  let jsonText: string;
  try {
    jsonText = readFileSync(configPath, 'utf8');
  } catch {
    console.log(`설정 파일을 찾을 수 없습니다: ${configPath}`);
    console.log('Claude Code에서 MCP 서버를 설정한 뒤 다시 시도하세요.');
    return;
  }

  const { specs, skipped } = collectServerSpecs(jsonText);
  for (const name of skipped)
    console.log(`- ${name}: stdio 서버가 아니어서 건너뜀 (command 필드 없음)`);
  if (specs.length === 0) {
    console.log('스캔할 stdio MCP 서버가 없습니다.');
    return;
  }

  const store = await LensStore.open(dbPath());
  for (const spec of specs) {
    try {
      const defs = await scanServer(spec);
      store.upsertDefinitions(defs);
      const total = defs.reduce((n, d) => n + d.definitionTokens, 0);
      console.log(`- ${spec.name}: ${defs.length}개 툴, ${total} 토큰`);
    } catch (e) {
      console.log(`- ${spec.name}: 스캔 실패 — ${(e as Error).message}`);
    }
  }
  store.save();
  store.close();
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
