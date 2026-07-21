import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HookClient = 'claude-code' | 'codex' | 'gemini-cli';
export type PackageState = 'installed' | 'missing';
export type TrustState = 'approved' | 'unapproved' | 'unknown' | 'not-required';
export type RunnerState = 'ready' | 'missing';
export type FallbackState = 'active' | 'inactive' | 'unknown';
export type HookHealth = 'idle' | 'healthy' | 'hook-only' | 'log-only' | 'degraded' | 'unavailable';

export interface HookStatus {
  client: HookClient;
  packageState: PackageState;
  trustState: TrustState;
  runnerState: RunnerState;
  lastEvent: string | null;
  pendingCount: number;
  fallbackState: FallbackState;
  health: HookHealth;
}

export interface HookHealthSnapshot {
  health: HookHealth;
  lastEvent: string | null;
  fallbackState: FallbackState;
}

export interface HookStatusDependencies {
  homeDirectory?: string;
  packageDirectories?: Partial<Record<HookClient, string>>;
  trustState?: (client: HookClient) => TrustState;
  healthSnapshot?: (client: HookClient) => HookHealthSnapshot | undefined;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  readDirectory?: (path: string) => string[];
  modifiedAt?: (path: string) => Date;
}

const CLIENTS: readonly HookClient[] = ['claude-code', 'codex', 'gemini-cli'];

export function collectHookStatus(dependencies: HookStatusDependencies = {}): HookStatus[] {
  const exists = dependencies.exists ?? existsSync;
  const readFile = dependencies.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const readDirectory = dependencies.readDirectory ?? ((path: string) => readdirSync(path));
  const modifiedAt = dependencies.modifiedAt ?? ((path: string) => statSync(path).mtime);
  const home = dependencies.homeDirectory ?? homedir();
  const inbox = join(home, '.mcplens', 'inbox');
  const pendingDirectory = join(inbox, 'pending');
  const defaultLastEvent = latestInboxEvent(inbox, readDirectory, modifiedAt);
  const pendingCount = countPending(pendingDirectory, readDirectory);

  return CLIENTS.map((client) => {
    const packageDirectory = dependencies.packageDirectories?.[client]
      ?? resolvePackageDirectory(client, home, exists, readFile, readDirectory);
    const packageState: PackageState = exists(packageDirectory) ? 'installed' : 'missing';
    const runnerState: RunnerState = packageState === 'installed'
      && exists(join(packageDirectory, 'scripts', 'hook-runner.mjs'))
      ? 'ready'
      : 'missing';
    const snapshot = dependencies.healthSnapshot?.(client);

    return {
      client,
      packageState,
      trustState: dependencies.trustState?.(client) ?? defaultTrustState(client),
      runnerState,
      lastEvent: snapshot?.lastEvent ?? defaultLastEvent,
      pendingCount,
      fallbackState: snapshot?.fallbackState ?? 'unknown',
      health: snapshot?.health ?? (defaultLastEvent === null ? 'unavailable' : 'idle'),
    };
  });
}

export function formatHookStatus(statuses: readonly HookStatus[], json: boolean): string {
  const ordered = [...statuses].sort((left, right) => left.client.localeCompare(right.client));
  if (json) return `${JSON.stringify(ordered, null, 2)}\n`;

  return ordered.map((status) => [
    clientLabel(status.client),
    `  package: ${status.packageState}`,
    `  trust: ${status.trustState}`,
    `  runner: ${status.runnerState}`,
    `  last event: ${status.lastEvent ?? 'none'}`,
    `  pending: ${status.pendingCount}`,
    `  fallback: ${status.fallbackState}`,
    `  health: ${status.health}`,
  ].join('\n')).join('\n\n').concat('\n');
}

function defaultPackageDirectory(home: string, client: HookClient): string {
  switch (client) {
    case 'claude-code': return join(home, '.claude', 'plugins', 'mcp-lens');
    case 'codex': return join(home, '.codex', 'plugins', 'mcp-lens');
    case 'gemini-cli': return join(home, '.gemini', 'extensions', 'mcp-lens');
  }
}

function resolvePackageDirectory(
  client: HookClient, home: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
  readDirectory: (path: string) => string[],
): string {
  if (client === 'claude-code') {
    return resolveClaudePackageDirectory(home, exists, readFile, readDirectory)
      ?? defaultPackageDirectory(home, client);
  }
  if (client === 'codex') {
    return resolveCachePackageDirectory(join(home, '.codex', 'plugins'), exists, readDirectory)
      ?? defaultPackageDirectory(home, client);
  }
  return defaultPackageDirectory(home, client);
}

// Claude Code records marketplace installs (with their resolved installPath) in
// installed_plugins.json — the authoritative signal. Fall back to the versioned
// cache layout and a legacy drop-in directory.
function resolveClaudePackageDirectory(
  home: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
  readDirectory: (path: string) => string[],
): string | null {
  const pluginsRoot = join(home, '.claude', 'plugins');
  const recorded = claudeInstalledPaths(pluginsRoot, readFile)
    .find((dir) => exists(join(dir, 'scripts', 'hook-runner.mjs')));
  if (recorded !== undefined) return recorded;
  return resolveCachePackageDirectory(pluginsRoot, exists, readDirectory);
}

function claudeInstalledPaths(
  pluginsRoot: string, readFile: (path: string) => string,
): string[] {
  try {
    const parsed = JSON.parse(readFile(join(pluginsRoot, 'installed_plugins.json')));
    const plugins = (parsed?.plugins ?? {}) as Record<string, unknown>;
    const paths: string[] = [];
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith('mcp-lens@') || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        const installPath = (entry as { installPath?: unknown }).installPath;
        if (typeof installPath === 'string') paths.push(installPath);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

// Both Claude Code and Codex install marketplace plugins under
// <pluginsRoot>/cache/<marketplace>/mcp-lens/<version>. Scan that layout — Codex
// records only an enabled flag in config.toml, so the cache dir is the reliable
// signal — while still honoring a legacy <pluginsRoot>/mcp-lens drop-in.
function resolveCachePackageDirectory(
  pluginsRoot: string,
  exists: (path: string) => boolean,
  readDirectory: (path: string) => string[],
): string | null {
  const candidates = [join(pluginsRoot, 'mcp-lens')];
  const cacheRoot = join(pluginsRoot, 'cache');
  for (const marketplace of safeReadDirectory(cacheRoot, readDirectory)) {
    const pluginDir = join(cacheRoot, marketplace, 'mcp-lens');
    for (const version of safeReadDirectory(pluginDir, readDirectory)) {
      candidates.push(join(pluginDir, version));
    }
  }
  return candidates.find((dir) => exists(join(dir, 'scripts', 'hook-runner.mjs'))) ?? null;
}

function safeReadDirectory(
  directory: string, readDirectory: (path: string) => string[],
): string[] {
  try {
    return readDirectory(directory);
  } catch {
    return [];
  }
}

function defaultTrustState(client: HookClient): TrustState {
  // Codex does not expose a stable readable trust-state API. Do not infer approval.
  return client === 'codex' ? 'unknown' : 'not-required';
}

function countPending(directory: string, readDirectory: (path: string) => string[]): number {
  try {
    return readDirectory(directory).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function latestInboxEvent(
  inbox: string,
  readDirectory: (path: string) => string[],
  modifiedAt: (path: string) => Date,
): string | null {
  let latest: Date | null = null;
  for (const directory of ['pending', 'processed']) {
    try {
      for (const name of readDirectory(join(inbox, directory))) {
        if (!name.endsWith('.json')) continue;
        const time = modifiedAt(join(inbox, directory, name));
        if (latest === null || time > latest) latest = time;
      }
    } catch {
      // A missing or unreadable inbox is represented as no observed event.
    }
  }
  return latest?.toISOString() ?? null;
}

function clientLabel(client: HookClient): string {
  switch (client) {
    case 'claude-code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'gemini-cli': return 'Gemini CLI';
  }
}
