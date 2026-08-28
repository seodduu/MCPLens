#!/usr/bin/env node
// packages/cli/src/main.ts
import { readFileSync } from 'node:fs';
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath, incompleteScans,
  ClaudeAdapter, CodexAdapter, GeminiAdapter,
  collectAllSpecs, configSources, collectFromSource,
  authenticateServer, clearStoredOAuth, readOAuthClients, oauthClientsFile,
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
    console.error(`unknown command: ${cmd}\n`);
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

  // report is a read command, but backfill ingests observations and calls save(). With the
  // lease we persist that ingest; without it (the extension holds it) the write guard marks us
  // a non-holder and only the save is skipped. The in-memory ingest still feeds this report,
  // so the output is identical either way.
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
      console.error('(another process is writing the DB, so this run is read-only)');
    }
    const since = new Date(Date.now() - days.value * 86_400_000).toISOString();
    const input = {
      definitions: store.allDefinitions(),
      calls: store.callsSince(since),
      loads: store.loadsSince(since),
      sessions: store.sessionsSince(since),
      lastCallByTool: store.lastCallByTool(),
      // A failed scan does not change the matrix, but it does change what the numbers can claim:
      // that server's rows came from call history alone. The formatter says so.
      scanStatuses: store.serverScanStatuses(),
    };
    console.log(formatReport(
      buildMatrix(input), sessionSavings(input), format.value, incompleteScans(input.scanStatuses),
    ));
    console.error(`(${files} session files backfilled)`);
    store.close();
  } finally {
    lease?.release();
  }
}

function watcherFor(store: LensStore): LogWatcher {
  return new LogWatcher(store, [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]);
}

/** Guard error core throws when a non-holder calls save(). Detected by name only (the class is private). */
function isStaleWriterError(e: unknown): boolean {
  return e instanceof Error && e.name === 'StaleWriterError';
}

/** Reads every configSources() file and counts discovered specs per source kind (read-only). */
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
      // A path the user named explicitly must exist. Exit 1 so scripts can detect it
      // (this differs from a full scan that simply finds zero servers).
      console.error(`config file not found: ${configPath}`);
      console.error('Check the path, or run without --config to read every detected config.');
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
    if (summary) console.log(`discovered: ${summary}`);
  }

  for (const name of skipped)
    console.log(`- ${name}: skipped, not a stdio server (no command field)`);
  // Zero servers in a single-file --config scan ends here; the mapping stays untouched
  // (attribution is undefined because we never observed every source).
  if (specs.length === 0 && attribution === undefined) {
    console.log('No MCP servers to scan.');
    return;
  }

  // Writing to the DB starts here. Opening without a lease means save() overwrites every
  // observation the extension ingested after open. Config reading and path validation are
  // already done above, so the lock covers only the section that needs it.
  const written = await withWriterLease((lease) =>
    scanIntoStore(specs, attribution, replaceable, identities, lease));
  if (!written.ok) { console.error(written.message); process.exit(1); }
}

/** Ingests scan results into the DB. Only call while holding the writer lease. */
async function scanIntoStore(
  specs: McpServerSpec[],
  attribution: Map<string, Set<ClientId>> | undefined,
  replaceable: Set<ClientId> | undefined,
  identities: ServerIdentity[],
  lease: WriterLeaseHandle,
): Promise<void> {
  const store = await LensStore.open(dbPath());
  // If the lease is lost (taken over by the extension) save is blocked with StaleWriterError.
  // Dropping this scan is better than overwriting someone else's observations.
  store.setWriteGuard(() => lease.isHolder());
  // Undefined for a single-file --config scan: we never observed every source, so replacing
  // would wrongly erase another client's mapping.
  if (attribution !== undefined && replaceable !== undefined)
    store.upsertClientServers(attribution, replaceable);
  if (specs.length === 0) {
    // Zero servers on the full-scan path; the mapping was already updated (emptied) above.
    console.log('No MCP servers to scan.');
    store.save();
    store.close();
    return;
  }
  for (const spec of specs) {
    const scannedAt = new Date().toISOString();
    const result = await scanOneServer(store, spec, scannedAt, identities);
    if (result.ok) {
      console.log(`- ${spec.name}: ${result.toolCount} tools, ${result.totalTokens} tokens`);
    } else {
      console.log(result.line);
    }
  }
  store.save();
  store.close();
}

/** `mcp-lens auth <serverName> [--clear]`: OAuth login for an http server, then rescan just that server. */
async function runAuth(args: string[]) {
  const rest = args.slice(1);
  const clear = rest.includes('--clear');
  const name = rest.find((a) => !a.startsWith('--'));

  if (!name) {
    console.log('usage: mcp-lens auth <serverName> [--clear]');
    process.exit(1);
    return;
  }

  if (clear) {
    clearStoredOAuth(name);
    console.log(`${name}: stored credentials deleted.`);
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
    // Servers that refuse dynamic registration only work with a client the user registered by hand.
    // The same file is written by the extension's sign-in prompt, so registering once covers both.
    await authenticateServer(target.spec, { openUrl, client: readOAuthClients()[name] });
  } catch (e) {
    // authenticateServer may rethrow SDK exceptions verbatim, so non-Error values arrive here.
    // Asserting (e as Error).message would throw a TypeError inside this catch block and expose
    // an unhandled crash instead of the DCR guidance below.
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${name}: login failed: ${msg}`);
    if (e instanceof Error && e.name === 'ClientRegistrationRequiredError') {
      console.log(
        `  This server does not register clients automatically (no DCR), e.g. GitHub and Figma remote MCP.\n` +
        `  Either register an OAuth app with the provider and put its client id in\n` +
        `  ${oauthClientsFile()}:\n` +
        `  { "${name}": { "clientId": "<client id>", "clientSecret": "<optional>" } }\n` +
        `  or put a PAT in the headers field of the config instead and it will scan:\n` +
        `  "${name}": { "type": "http", "url": "...", "headers": { "Authorization": "Bearer <token>" } }`);
    }
    process.exit(1);
    return;
  }

  // Take the lease only right before opening the DB. Browser login can take arbitrarily long,
  // and holding the lock through it would block the extension from saving anything.
  const rescan = await withWriterLease(async (lease) => {
    const store = await LensStore.open(dbPath());
    store.setWriteGuard(() => lease.isHolder());
    const scannedAt = new Date().toISOString();
    await runAuthRescan(store, target.spec, scannedAt);
  });
  if (!rescan.ok) {
    console.error(`${name}: login succeeded but the result could not be saved.`);
    console.error(rescan.message);
    process.exit(1);
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
