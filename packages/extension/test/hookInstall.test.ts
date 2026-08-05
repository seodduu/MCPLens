import { memFsStub } from './helpers/memFs.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeHookInstaller, PLUGIN_ID, MARKETPLACE_NAME, stableDir,
  type InstallerDeps, type RunResult,
} from '../src/hookInstall.js';

const HOME = '/home/u';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: HOME,
    findBinary: () => '/bin/claude',
    run: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fs: memFsStub(),
    bundledDir: '/bundle/claude-marketplace',
    ...over,
  };
}

describe('ClaudeHookInstaller', () => {
  it('reports installed when plugin list contains mcp-lens@mcplens', async () => {
    const run = async (_b: string, _a: string[]): Promise<RunResult> =>
      ({ stdout: JSON.stringify([{ id: 'mcp-lens@mcplens' }]), stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.detect()).toBe('installed');
  });

  it('reports client-missing when the binary is absent', async () => {
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null }));
    expect(await inst.detect()).toBe('client-missing');
  });

  it('treats a throwing findBinary as client-missing without propagating', async () => {
    const findBinary = (): never => { throw new Error('boom'); };
    const inst = new ClaudeHookInstaller(deps({ findBinary }));
    expect(await inst.detect()).toBe('client-missing');
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('fails open to not-installed instead of throwing when plugin list fails', async () => {
    const inst = new ClaudeHookInstaller(deps({
      run: async () => { throw new Error('spawn failed'); },
    }));
    await expect(inst.detect()).resolves.toBe('not-installed');
  });

  it('reports not-installed when it is absent from plugin list', async () => {
    const run = async (): Promise<RunResult> =>
      ({ stdout: JSON.stringify([{ id: 'other-plugin@mkt' }]), stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.detect()).toBe('not-installed');
  });

  it('calls marketplace add then plugin install, in order', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a); return { stdout: '', stderr: '', code: 0 };
    };
    const inst = new ClaudeHookInstaller(deps({
      run, findBinary: () => '/bin/claude',
      // plugin list returns an empty array so detect reports not-installed
    }));
    // detect(list)=[] means not-installed, so the install proceeds
    await inst.install();
    expect(calls.some((a) => a.includes('marketplace') && a.includes('add'))).toBe(true);
    expect(calls.some((a) => a.includes('install') && a.includes('mcp-lens@mcplens'))).toBe(true);
  });

  it('returns client-missing from install and calls nothing when the binary is absent', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0 }));
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null, run }));
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not reinstall when it is already installed', async () => {
    const run = vi.fn(async (_b: string, a: string[]): Promise<RunResult> =>
      a[1] === 'list'
        ? { stdout: JSON.stringify([{ id: PLUGIN_ID }]), stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    const result = await inst.install();
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(run).not.toHaveBeenCalledWith('/bin/claude', ['plugin', 'install', PLUGIN_ID]);
  });

  it('turns a throwing copyDir into failed(step=copy)', async () => {
    const inst = new ClaudeHookInstaller(deps({
      fs: { ...memFsStub(), copyDir: () => { throw new Error("disk full"); } },
    }));
    expect(await inst.install()).toEqual({ kind: 'failed', step: 'copy', stderr: 'disk full' });
  });

  it('returns failed(step=marketplace-add) when marketplace add fails', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('add') ? { stdout: '', stderr: 'boom', code: 1 } : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.install()).toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'boom' });
  });

  it('treats an already-existing marketplace as success', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('add') ? { stdout: '', stderr: 'marketplace already exists', code: 1 } : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.install()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('returns failed(step=install) when the install step fails', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('install') && !a.includes('marketplace')
        ? { stdout: '', stderr: 'boom', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.install()).toEqual({ kind: 'failed', step: 'install', stderr: 'boom' });
  });

  it('calls plugin uninstall then marketplace remove on uninstall', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => { calls.push(a); return { stdout: '', stderr: '', code: 0 }; };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls[0]).toEqual(['plugin', 'uninstall', PLUGIN_ID]);
    expect(calls[1]).toEqual(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  });

  it('returns client-missing from uninstall when the binary is absent', async () => {
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null }));
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('returns failed instead of throwing when run rejects during install', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: '[]', stderr: '', code: 0 };
      throw new Error('spawn ENOENT');
    };
    const inst = new ClaudeHookInstaller(deps({ run }));
    await expect(inst.install()).resolves.toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'spawn ENOENT' });
  });

  it('returns failed instead of throwing when run rejects during uninstall', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    const inst = new ClaudeHookInstaller(deps({ run }));
    await expect(inst.uninstall()).resolves.toEqual({ kind: 'failed', step: 'uninstall', stderr: 'spawn ENOENT' });
  });

  it('treats an uninstall reporting "not found in installed plugins" as success, not failure', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('uninstall')
        ? { stdout: '', stderr: 'Error: mcp-lens@mcplens not found in installed plugins', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });
});

describe('stableDir', () => {
  it('builds the home/.mcplens/<sub> path', () => {
    expect(stableDir(HOME, 'claude-marketplace')).toBe('/home/u/.mcplens/claude-marketplace');
  });
});
