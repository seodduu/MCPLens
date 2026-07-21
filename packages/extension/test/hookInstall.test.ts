import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeHookInstaller, PLUGIN_ID, MARKETPLACE_NAME, stableDir,
  detectClaudeHookInstall, installClaudeHooks, uninstallClaudeHooks,
  type InstallerDeps, type RunResult, type HookInstallDeps,
} from '../src/hookInstall.js';

const HOME = '/home/u';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: HOME,
    findBinary: () => '/bin/claude',
    run: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fs: { copyDir: () => {}, exists: () => false, readDir: () => [] },
    bundledDir: '/bundle/claude-marketplace',
    ...over,
  };
}

describe('ClaudeHookInstaller', () => {
  it('plugin list에 mcp-lens@mcplens 있으면 installed', async () => {
    const run = async (_b: string, _a: string[]): Promise<RunResult> =>
      ({ stdout: JSON.stringify([{ id: 'mcp-lens@mcplens' }]), stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.detect()).toBe('installed');
  });

  it('바이너리 없으면 client-missing', async () => {
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null }));
    expect(await inst.detect()).toBe('client-missing');
  });

  it('plugin list가 실패해도 던지지 않고 not-installed로 fail-open한다', async () => {
    const inst = new ClaudeHookInstaller(deps({
      run: async () => { throw new Error('spawn failed'); },
    }));
    await expect(inst.detect()).resolves.toBe('not-installed');
  });

  it('plugin list에 없으면 not-installed', async () => {
    const run = async (): Promise<RunResult> =>
      ({ stdout: JSON.stringify([{ id: 'other-plugin@mkt' }]), stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.detect()).toBe('not-installed');
  });

  it('install은 marketplace add → plugin install 순서로 호출한다', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a); return { stdout: '', stderr: '', code: 0 };
    };
    const inst = new ClaudeHookInstaller(deps({
      run, findBinary: () => '/bin/claude',
      // detect가 not-installed이 되도록 plugin list는 빈 배열
    }));
    // detect(list)=[] → not-installed → 설치 진행
    await inst.install();
    expect(calls.some((a) => a.includes('marketplace') && a.includes('add'))).toBe(true);
    expect(calls.some((a) => a.includes('install') && a.includes('mcp-lens@mcplens'))).toBe(true);
  });

  it('install은 바이너리가 없으면 client-missing을 반환하고 아무것도 호출하지 않는다', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0 }));
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null, run }));
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('이미 설치된 경우 재설치하지 않는다', async () => {
    const run = vi.fn(async (_b: string, a: string[]): Promise<RunResult> =>
      a[1] === 'list'
        ? { stdout: JSON.stringify([{ id: PLUGIN_ID }]), stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    const result = await inst.install();
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(run).not.toHaveBeenCalledWith('/bin/claude', ['plugin', 'install', PLUGIN_ID]);
  });

  it('copyDir이 던지면 failed(step=copy)로 변환한다', async () => {
    const inst = new ClaudeHookInstaller(deps({
      fs: { copyDir: () => { throw new Error('disk full'); }, exists: () => false, readDir: () => [] },
    }));
    expect(await inst.install()).toEqual({ kind: 'failed', step: 'copy', stderr: 'disk full' });
  });

  it('marketplace add 실패 시 failed(step=marketplace-add)를 반환한다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('add') ? { stdout: '', stderr: 'boom', code: 1 } : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.install()).toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'boom' });
  });

  it('marketplace가 이미 존재하면 성공으로 취급한다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('add') ? { stdout: '', stderr: 'marketplace already exists', code: 1 } : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.install()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('install 단계 실패 시 failed(step=install)를 반환한다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> =>
      a.includes('install') && !a.includes('marketplace')
        ? { stdout: '', stderr: 'boom', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.install()).toEqual({ kind: 'failed', step: 'install', stderr: 'boom' });
  });

  it('uninstall은 plugin uninstall 후 marketplace remove를 호출한다', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => { calls.push(a); return { stdout: '', stderr: '', code: 0 }; };
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls[0]).toEqual(['plugin', 'uninstall', PLUGIN_ID]);
    expect(calls[1]).toEqual(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  });

  it('uninstall은 바이너리가 없으면 client-missing을 반환한다', async () => {
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null }));
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('install 중 run이 reject해도 던지지 않고 failed를 반환한다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: '[]', stderr: '', code: 0 };
      throw new Error('spawn ENOENT');
    };
    const inst = new ClaudeHookInstaller(deps({ run }));
    await expect(inst.install()).resolves.toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'spawn ENOENT' });
  });

  it('uninstall 중 run이 reject해도 던지지 않고 failed를 반환한다', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    const inst = new ClaudeHookInstaller(deps({ run }));
    await expect(inst.uninstall()).resolves.toEqual({ kind: 'failed', step: 'uninstall', stderr: 'spawn ENOENT' });
  });
});

describe('stableDir', () => {
  it('home/.mcplens/<sub> 경로를 생성한다', () => {
    expect(stableDir(HOME, 'claude-marketplace')).toBe('/home/u/.mcplens/claude-marketplace');
  });
});

// ---- Legacy compatibility wrappers ------------------------------------------
// extension.ts still calls these Claude-only, function-style entry points.
// They must keep behaving like before while delegating to ClaudeHookInstaller.

function legacyDeps(over: Partial<HookInstallDeps> = {}): HookInstallDeps {
  return {
    home: HOME,
    findClaudeBinary: () => '/bin/claude',
    runClaude: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fs: { copyDir: vi.fn(), exists: () => false, readDir: () => [] },
    bundledMarketplaceDir: '/ext/dist/claude-marketplace',
    ...over,
  };
}

describe('installClaudeHooks (legacy wrapper)', () => {
  it('installs via marketplace add then plugin install when absent', async () => {
    const calls: string[][] = [];
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });
    const copyDir = vi.fn();
    const result = await installClaudeHooks(legacyDeps({ runClaude, fs: { copyDir, exists: () => false, readDir: () => [] } }));

    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(copyDir).toHaveBeenCalledWith('/ext/dist/claude-marketplace', stableDir(HOME, 'claude-marketplace'));
    expect(calls).toContainEqual(['plugin', 'marketplace', 'add', stableDir(HOME, 'claude-marketplace')]);
    expect(calls).toContainEqual(['plugin', 'install', PLUGIN_ID]);
  });

  it('skips install when plugin list already reports it installed', async () => {
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> =>
      args[1] === 'list'
        ? { stdout: JSON.stringify([{ id: PLUGIN_ID, enabled: true }]), stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 });
    const result = await installClaudeHooks(legacyDeps({ runClaude }));

    expect(result).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(runClaude).not.toHaveBeenCalledWith(['plugin', 'install', PLUGIN_ID]);
  });

  it('returns claude-missing without running anything', async () => {
    const runClaude = vi.fn(async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0 }));
    const result = await installClaudeHooks(legacyDeps({ findClaudeBinary: () => null, runClaude }));
    expect(result).toEqual({ kind: 'claude-missing' });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('reports failure with the step and stderr on non-zero install', async () => {
    const runClaude = async (args: string[]): Promise<RunResult> =>
      args[1] === 'install'
        ? { stdout: '', stderr: 'boom', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const result = await installClaudeHooks(legacyDeps({ runClaude }));
    expect(result).toEqual({ kind: 'failed', step: 'install', stderr: 'boom' });
  });

  it('treats an already-existing marketplace as success', async () => {
    const runClaude = async (args: string[]): Promise<RunResult> =>
      args[2] === 'add'
        ? { stdout: '', stderr: 'marketplace already exists', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const result = await installClaudeHooks(legacyDeps({ runClaude }));
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('returns a failed result instead of throwing when copyDir throws', async () => {
    const copyDir = () => { throw new Error('disk full'); };
    const result = await installClaudeHooks(legacyDeps({ fs: { copyDir, exists: () => false, readDir: () => [] } }));
    expect(result).toEqual({ kind: 'failed', step: 'copy', stderr: 'disk full' });
  });
});

describe('detectClaudeHookInstall (legacy wrapper)', () => {
  it('returns claude-missing when the binary cannot be found', async () => {
    const state = await detectClaudeHookInstall(legacyDeps({ findClaudeBinary: () => null }));
    expect(state).toBe('claude-missing');
  });

  it('returns not-installed when plugin list fails, without throwing', async () => {
    const state = await detectClaudeHookInstall(legacyDeps({
      runClaude: async () => ({ stdout: '', stderr: 'err', code: 1 }),
    }));
    expect(state).toBe('not-installed');
  });

  it('trusts a successful plugin list (uninstalled → not-installed)', async () => {
    const state = await detectClaudeHookInstall(legacyDeps({
      runClaude: async () => ({ stdout: JSON.stringify([{ id: 'other-plugin@mkt' }]), stderr: '', code: 0 }),
    }));
    expect(state).toBe('not-installed');
  });

  it('reports installed when the plugin id is present', async () => {
    const state = await detectClaudeHookInstall(legacyDeps({
      runClaude: async () => ({ stdout: JSON.stringify([{ id: PLUGIN_ID }]), stderr: '', code: 0 }),
    }));
    expect(state).toBe('installed');
  });
});

describe('uninstallClaudeHooks (legacy wrapper)', () => {
  it('uninstalls the plugin then removes the marketplace', async () => {
    const calls: string[][] = [];
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const result = await uninstallClaudeHooks(legacyDeps({ runClaude }));
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls[0]).toEqual(['plugin', 'uninstall', PLUGIN_ID]);
    expect(calls[1]).toEqual(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  });

  it('returns claude-missing without running anything', async () => {
    const runClaude = vi.fn(async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0 }));
    const result = await uninstallClaudeHooks(legacyDeps({ findClaudeBinary: () => null, runClaude }));
    expect(result).toEqual({ kind: 'claude-missing' });
    expect(runClaude).not.toHaveBeenCalled();
  });
});
