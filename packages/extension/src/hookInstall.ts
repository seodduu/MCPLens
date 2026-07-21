import { join } from 'node:path';

export interface RunResult { stdout: string; stderr: string; code: number; }

export interface HookInstallDeps {
  home: string;
  findClaudeBinary: () => string | null;
  runClaude: (args: string[]) => Promise<RunResult>;
  fs: {
    copyDir: (from: string, to: string) => void;
    exists: (path: string) => boolean;
    readDir: (path: string) => string[];
  };
  bundledMarketplaceDir: string;
}

export const MARKETPLACE_NAME = 'mcplens';
export const PLUGIN_ID = 'mcp-lens@mcplens';

export type InstallState = 'installed' | 'not-installed' | 'claude-missing';

export type InstallResult =
  | { kind: 'ok'; alreadyInstalled: boolean }
  | { kind: 'claude-missing' }
  | { kind: 'failed'; step: string; stderr: string };

export function stableMarketplaceDir(home: string): string {
  return join(home, '.mcplens', 'claude-marketplace');
}

export async function detectClaudeHookInstall(deps: HookInstallDeps): Promise<InstallState> {
  if (deps.findClaudeBinary() === null) return 'claude-missing';
  try {
    const r = await deps.runClaude(['plugin', 'list', '--json']);
    // A successful `plugin list` is authoritative — trust it either way. `claude
    // plugin uninstall` leaves the versioned cache dir behind, so falling through
    // to the cache scan here would falsely report a removed plugin as installed.
    if (r.code === 0) return pluginListReportsInstalled(r.stdout) ? 'installed' : 'not-installed';
  } catch {
    // The CLI could not report — fall back to the filesystem cache check.
  }
  return hasCachedRunner(deps) ? 'installed' : 'not-installed';
}

export async function installClaudeHooks(deps: HookInstallDeps): Promise<InstallResult> {
  try {
    const state = await detectClaudeHookInstall(deps);
    if (state === 'claude-missing') return { kind: 'claude-missing' };
    if (state === 'installed') return { kind: 'ok', alreadyInstalled: true };

    const target = stableMarketplaceDir(deps.home);
    deps.fs.copyDir(deps.bundledMarketplaceDir, target);

    const add = await deps.runClaude(['plugin', 'marketplace', 'add', target]);
    if (add.code !== 0 && !isAlreadyPresent(add.stderr)) {
      return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
    }
    const install = await deps.runClaude(['plugin', 'install', PLUGIN_ID]);
    if (install.code !== 0 && !isAlreadyPresent(install.stderr)) {
      return { kind: 'failed', step: 'install', stderr: install.stderr };
    }
    return { kind: 'ok', alreadyInstalled: false };
  } catch (error) {
    return { kind: 'failed', step: 'unexpected', stderr: errorMessage(error) };
  }
}

export async function uninstallClaudeHooks(deps: HookInstallDeps): Promise<InstallResult> {
  try {
    if (deps.findClaudeBinary() === null) return { kind: 'claude-missing' };
    const uninstall = await deps.runClaude(['plugin', 'uninstall', PLUGIN_ID]);
    if (uninstall.code !== 0 && !/not installed|no such/i.test(uninstall.stderr)) {
      return { kind: 'failed', step: 'uninstall', stderr: uninstall.stderr };
    }
    await deps.runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    return { kind: 'ok', alreadyInstalled: false };
  } catch (error) {
    return { kind: 'failed', step: 'unexpected', stderr: errorMessage(error) };
  }
}

// `claude plugin list --json` emits an array of installed plugins, each with an
// `id` like "mcp-lens@mcplens". Parse it rather than scraping the multi-line
// text format (where the id and its status live on separate lines).
function pluginListReportsInstalled(stdout: string): boolean {
  try {
    const plugins: unknown = JSON.parse(stdout);
    return Array.isArray(plugins)
      && plugins.some((p) => (p as { id?: unknown })?.id === PLUGIN_ID);
  } catch {
    return false;
  }
}

function hasCachedRunner(deps: HookInstallDeps): boolean {
  const cacheRoot = join(deps.home, '.claude', 'plugins', 'cache');
  for (const marketplace of safeReadDir(deps, cacheRoot)) {
    const pluginDir = join(cacheRoot, marketplace, 'mcp-lens');
    for (const version of safeReadDir(deps, pluginDir)) {
      if (deps.fs.exists(join(pluginDir, version, 'scripts', 'hook-runner.mjs'))) return true;
    }
  }
  return false;
}

function safeReadDir(deps: HookInstallDeps, dir: string): string[] {
  try { return deps.fs.readDir(dir); } catch { return []; }
}

function isAlreadyPresent(stderr: string): boolean {
  return /already (exists|added|installed)/i.test(stderr);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
