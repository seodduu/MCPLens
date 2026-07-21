import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  detectClaudeHookInstall, installClaudeHooks, uninstallClaudeHooks,
  stableMarketplaceDir, PLUGIN_ID, MARKETPLACE_NAME,
  type HookInstallDeps, type RunResult,
} from '../src/hookInstall.js';

const HOME = '/home/u';
function deps(over: Partial<HookInstallDeps> = {}): HookInstallDeps {
  return {
    home: HOME,
    findClaudeBinary: () => '/bin/claude',
    runClaude: async () => ({ stdout: '', stderr: '', code: 0 }),
    fs: { copyDir: vi.fn(), exists: () => false, readDir: () => [] },
    bundledMarketplaceDir: '/ext/dist/claude-marketplace',
    ...over,
  };
}

describe('installClaudeHooks', () => {
  it('installs via marketplace add then plugin install when absent', async () => {
    const calls: string[][] = [];
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[1] === 'list') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const copyDir = vi.fn();
    const result = await installClaudeHooks(deps({ runClaude, fs: { copyDir, exists: () => false, readDir: () => [] } }));

    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(copyDir).toHaveBeenCalledWith('/ext/dist/claude-marketplace', stableMarketplaceDir(HOME));
    expect(calls).toContainEqual(['plugin', 'marketplace', 'add', stableMarketplaceDir(HOME)]);
    expect(calls).toContainEqual(['plugin', 'install', PLUGIN_ID]);
  });

  it('skips install when plugin list already reports it installed', async () => {
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> =>
      args[1] === 'list'
        ? { stdout: `${PLUGIN_ID}  installed, enabled  0.1.0`, stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 });
    const result = await installClaudeHooks(deps({ runClaude }));

    expect(result).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(runClaude).not.toHaveBeenCalledWith(['plugin', 'install', PLUGIN_ID]);
  });

  it('returns claude-missing without running anything', async () => {
    const runClaude = vi.fn(async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0 }));
    const result = await installClaudeHooks(deps({ findClaudeBinary: () => null, runClaude }));
    expect(result).toEqual({ kind: 'claude-missing' });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('reports failure with the step and stderr on non-zero install', async () => {
    const runClaude = async (args: string[]): Promise<RunResult> =>
      args[1] === 'install'
        ? { stdout: '', stderr: 'boom', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const result = await installClaudeHooks(deps({ runClaude }));
    expect(result).toEqual({ kind: 'failed', step: 'install', stderr: 'boom' });
  });

  it('treats an already-existing marketplace as success', async () => {
    const runClaude = async (args: string[]): Promise<RunResult> =>
      args[2] === 'add'
        ? { stdout: '', stderr: 'marketplace already exists', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const result = await installClaudeHooks(deps({ runClaude }));
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('returns a failed result instead of throwing when copyDir throws', async () => {
    const copyDir = () => { throw new Error('disk full'); };
    const result = await installClaudeHooks(deps({ fs: { copyDir, exists: () => false, readDir: () => [] } }));
    expect(result).toEqual({ kind: 'failed', step: 'unexpected', stderr: 'disk full' });
  });
});

describe('detectClaudeHookInstall', () => {
  it('falls back to the cache-glob when plugin list is unavailable', async () => {
    const cache = join(HOME, '.claude', 'plugins', 'cache');
    const runner = join(cache, 'mcplens', 'mcp-lens', '0.1.0', 'scripts', 'hook-runner.mjs');
    const state = await detectClaudeHookInstall(deps({
      runClaude: async () => ({ stdout: '', stderr: 'err', code: 1 }),
      fs: {
        copyDir: () => {}, exists: (p) => p === runner,
        readDir: (p) => {
          if (p === cache) return ['mcplens'];
          if (p === join(cache, 'mcplens', 'mcp-lens')) return ['0.1.0'];
          return [];
        },
      },
    }));
    expect(state).toBe('installed');
  });
});

describe('uninstallClaudeHooks', () => {
  it('uninstalls the plugin then removes the marketplace', async () => {
    const calls: string[][] = [];
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const result = await uninstallClaudeHooks(deps({ runClaude }));
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls[0]).toEqual(['plugin', 'uninstall', PLUGIN_ID]);
    expect(calls[1]).toEqual(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  });
});
