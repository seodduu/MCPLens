#!/usr/bin/env node
// packages/cli/src/main.ts
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath,
  ClaudeAdapter, CodexAdapter, GeminiAdapter } from '@mcp-lens/core';
import { formatReport } from './report.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'report';
  const days = Number(argValue(args, '--days') ?? '30');
  const format = (argValue(args, '--format') ?? 'table') as 'table' | 'ai' | 'json';
  if (cmd !== 'report') { console.error(`unknown command: ${cmd}`); process.exit(1); }

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
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
