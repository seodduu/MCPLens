import { memFsStub } from '../helpers/memFs.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexHookInstaller } from '../../src/installers/codex.js';
import { PLUGIN_ID, MARKETPLACE_NAME, stableDir, type InstallerDeps, type RunResult } from '../../src/hookInstall.js';
import { CODEX_HOOK_STATE_KEYS } from '../../src/installers/codexHookState.js';

const here = join(fileURLToPath(import.meta.url), '..');
/** Measured `codex plugin list --json` output (codex-cli 0.144.6). */
const listJson = readFileSync(join(here, '../fixtures/codex-plugin-list.json'), 'utf8');
/** State without mcp-lens: measured, an uninstalled plugin is absent from installed[] entirely. */
const emptyJson = JSON.stringify({ installed: [], available: [] });

const HOME = '/home/u';
const CONFIG_PATH = join(HOME, '.codex', 'config.toml');

/** config.toml body with `enabled = true` (and optionally trusted_hash) on all four of our hooks. */
function configWith(opts: { enabled?: boolean; trusted?: boolean } = {}): string {
  const { enabled = true, trusted = false } = opts;
  return CODEX_HOOK_STATE_KEYS.map((key) => [
    `[hooks.state."${key}"]`,
    ...(enabled ? ['enabled = true'] : []),
    ...(trusted ? ['trusted_hash = "sha256:x"'] : []),
    '',
  ].join('\n')).join('\n');
}

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: HOME,
    findBinary: () => '/bin/codex',
    run: async () => ({ stdout: listJson, stderr: '', code: 0 }),
    fs: memFsStub(),
    bundledDir: '/bundle/codex-marketplace',
    ...over,
  };
}

/** run that records its arguments, returns the given JSON for list and success for everything else. */
function recorder(listOut = emptyJson, rest: Partial<RunResult> = {}) {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args.includes('list')) return { stdout: listOut, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0, ...rest };
  };
  return { calls, run };
}

describe('CodexHookInstaller.detect', () => {
  it('reports installed when the measured fixture contains mcp-lens@mcplens', async () => {
    expect(await new CodexHookInstaller(deps()).detect()).toBe('installed');
  });

  it('reports not-installed when it is absent from installed[]', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: emptyJson, stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed when the entry has installed:false', async () => {
    const stdout = JSON.stringify({
      installed: [{ pluginId: PLUGIN_ID, name: 'mcp-lens', marketplaceName: 'mcplens', installed: false }],
      available: [],
    });
    const run = async (): Promise<RunResult> => ({ stdout, stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports client-missing when the binary is absent', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).detect()).toBe('client-missing');
  });

  it('treats a throwing findBinary as client-missing without propagating', async () => {
    const findBinary = (): never => { throw new Error('boom'); };
    const inst = new CodexHookInstaller(deps({ findBinary }));
    expect(await inst.detect()).toBe('client-missing');
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('finds the codex binary by name', async () => {
    const asked: string[] = [];
    const findBinary = (n: string): string | null => { asked.push(n); return '/bin/codex'; };
    await new CodexHookInstaller(deps({ findBinary })).detect();
    expect(asked).toEqual(['codex']);
  });

  it('reports not-installed without throwing on broken JSON', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: 'not json {{', stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed on a non-zero exit code', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: listJson, stderr: 'boom', code: 2 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed without propagating when run throws', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed and reruns the install when the plugin exists but enabled is missing', async () => {
    const fs = memFsStub({ [CONFIG_PATH]: '[features]\nplugin_hooks = true\n' });
    expect(await new CodexHookInstaller(deps({ fs })).detect()).toBe('not-installed');
  });

  it('reports needs-approval when enabled is present and trusted_hash is missing', async () => {
    const fs = memFsStub({ [CONFIG_PATH]: configWith({ enabled: true, trusted: false }) });
    expect(await new CodexHookInstaller(deps({ fs })).detect()).toBe('needs-approval');
  });

  it('reports installed when both enabled and trusted_hash are present', async () => {
    const fs = memFsStub({ [CONFIG_PATH]: configWith({ enabled: true, trusted: true }) });
    expect(await new CodexHookInstaller(deps({ fs })).detect()).toBe('installed');
  });

  it('reports installed fail-open when the config cannot be read', async () => {
    // memFsStub default: readFile throws when config.toml is missing.
    expect(await new CodexHookInstaller(deps()).detect()).toBe('installed');
  });
});

describe('CodexHookInstaller.install', () => {
  it('runs snapshot copy, marketplace add, then plugin add in order', async () => {
    const copied: [string, string][] = [];
    const { calls, run } = recorder();
    const d = deps({ run, fs: { ...memFsStub(), copyDir: (f: string, t: string) => { copied.push([f, t]); } } });
    const res = await new CodexHookInstaller(d).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(copied).toEqual([['/bundle/codex-marketplace', stableDir(HOME, 'codex-marketplace')]]);
    const mutations = calls.filter((a) => !a.includes('list'));
    expect(mutations).toEqual([
      ['plugin', 'marketplace', 'add', stableDir(HOME, 'codex-marketplace')],
      ['plugin', 'add', PLUGIN_ID],
    ]);
  });

  it('returns alreadyInstalled early and runs nothing when it is already installed', async () => {
    const { calls, run } = recorder(listJson);
    let copies = 0;
    const d = deps({ run, fs: { ...memFsStub(), copyDir: () => { copies += 1; } } });

    expect(await new CodexHookInstaller(d).install()).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(copies).toBe(0);
    expect(calls.filter((a) => !a.includes('list'))).toEqual([]);
  });

  it('reports client-missing when the binary is absent', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).install()).toEqual({ kind: 'client-missing' });
  });

  it('reports failed with step=copy when the copy fails', async () => {
    const { run } = recorder();
    const fs = { copyDir: () => { throw new Error('EACCES'); }, exists: () => false, readDir: () => [] };
    expect(await new CodexHookInstaller(deps({ run, fs })).install())
      .toEqual({ kind: 'failed', step: 'copy', stderr: 'EACCES' });
  });

  it('reports failed with step=marketplace-add and skips plugin add when marketplace add fails', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a);
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      return { stdout: '', stderr: 'bad manifest', code: 1 };
    };
    const res = await new CodexHookInstaller(deps({ run })).install();
    expect(res).toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'bad manifest' });
    expect(calls.some((a) => a.includes('add') && a.includes(PLUGIN_ID))).toBe(false);
  });

  it('reports failed with step=install when plugin add fails', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      if (a.includes('marketplace')) return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: 'no such plugin', code: 1 };
    };
    expect(await new CodexHookInstaller(deps({ run })).install())
      .toEqual({ kind: 'failed', step: 'install', stderr: 'no such plugin' });
  });

  it('does not treat an already-added message as a failure', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      return { stdout: '', stderr: 'Marketplace `mcplens` is already added', code: 1 };
    };
    expect(await new CodexHookInstaller(deps({ run })).install()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('returns failed without propagating when run throws', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      throw new Error('spawn ENOENT');
    };
    const res = await new CodexHookInstaller(deps({ run })).install();
    expect(res).toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'spawn ENOENT' });
  });

  it('writes enabled = true into config.toml on install and leaves a backup', async () => {
    const { run } = recorder(emptyJson);
    const before = '[features]\nplugin_hooks = true\n';
    const fs = memFsStub({ [CONFIG_PATH]: before });
    const written: Record<string, string> = {};
    const wrappedFs = {
      ...fs,
      writeFile: (p: string, content: string) => { written[p] = content; fs.writeFile(p, content); },
    };
    const res = await new CodexHookInstaller(deps({ run, fs: wrappedFs })).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(written[`${CONFIG_PATH}.mcplens.bak`]).toBe(before);
    expect(written[CONFIG_PATH]).toContain('enabled = true');
    expect(written[CONFIG_PATH]).toContain('[features]');
  });

  it('returns alreadyInstalled early from install when it is needs-approval', async () => {
    const fs = memFsStub({ [CONFIG_PATH]: configWith({ enabled: true, trusted: false }) });
    const { calls, run } = recorder(listJson);
    const res = await new CodexHookInstaller(deps({ run, fs })).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(calls.filter((a) => !a.includes('list'))).toEqual([]);
  });
});

describe('CodexHookInstaller.uninstall', () => {
  it('runs plugin remove then marketplace remove in order', async () => {
    const { calls, run } = recorder();
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls).toEqual([
      ['plugin', 'remove', PLUGIN_ID],
      ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
    ]);
  });

  it('reports client-missing when the binary is absent', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('reports failed with step=uninstall and skips marketplace remove when plugin remove fails', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a);
      return { stdout: '', stderr: 'permission denied', code: 1 };
    };
    expect(await new CodexHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'permission denied' });
    expect(calls.some((a) => a.includes('marketplace'))).toBe(false);
  });

  it('does not treat a not-installed message as a failure', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '', stderr: 'plugin is not installed', code: 1 });
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('ignores a marketplace remove failure (measured: exit 1 when it is unset)', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => a.includes('marketplace')
      ? { stdout: '', stderr: 'marketplace `mcplens` is not configured or installed', code: 1 }
      : { stdout: '', stderr: '', code: 0 };
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('does not propagate when run throws', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new CodexHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'spawn ENOENT' });
  });

  it('does not treat a "not found" message as a failure either', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '', stderr: 'plugin not found', code: 1 });
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });
});

describe('the codex-marketplace.json asset', () => {
  const manifest = JSON.parse(
    readFileSync(join(here, '../../assets/codex-marketplace.json'), 'utf8'),
  ) as { name: string; plugins: { name: string; source: { source: string; path: string } }[] };

  it('composes PLUGIN_ID from the marketplace name and the plugin name', () => {
    expect(manifest.name).toBe(MARKETPLACE_NAME);
    expect(`${manifest.plugins[0].name}@${manifest.name}`).toBe(PLUGIN_ID);
  });

  it('points the plugin source at the snapshot-relative ./plugins/mcp-lens', () => {
    expect(manifest.plugins[0].source).toEqual({ source: 'local', path: './plugins/mcp-lens' });
  });
});
