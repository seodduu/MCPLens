import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  collectHookStatus,
  formatHookStatus,
  type HookStatus,
  type HookStatusDependencies,
} from '../src/hooks-status.js';

const HOME = '/home/u';
const INSTALLED = join(HOME, '.claude', 'plugins', 'installed_plugins.json');
const CACHE_DIR = join(HOME, '.claude', 'plugins', 'cache', 'mcplens-local', 'mcp-lens', '0.1.0');
const CACHE_RUNNER = join(CACHE_DIR, 'scripts', 'hook-runner.mjs');

function baseDeps(overrides: HookStatusDependencies = {}): HookStatusDependencies {
  return {
    homeDirectory: HOME,
    exists: () => false,
    readFile: () => { throw new Error('ENOENT'); },
    readDirectory: () => [],
    modifiedAt: () => new Date(0),
    ...overrides,
  };
}

function claudeStatus(deps: HookStatusDependencies): HookStatus {
  return collectHookStatus(deps).find((s) => s.client === 'claude-code')!;
}

const CODEX_CACHE = join(HOME, '.codex', 'plugins', 'cache');
const CODEX_DIR = join(CODEX_CACHE, 'mcplens-local', 'mcp-lens', '0.1.0');
const CODEX_RUNNER = join(CODEX_DIR, 'scripts', 'hook-runner.mjs');

function codexStatus(deps: HookStatusDependencies): HookStatus {
  return collectHookStatus(deps).find((s) => s.client === 'codex')!;
}

const status = (client: HookStatus['client']): HookStatus => ({
  client,
  packageState: 'installed',
  trustState: client === 'codex' ? 'unknown' : 'not-required',
  runnerState: 'ready',
  lastEvent: '2026-07-20T12:00:00.000Z',
  pendingCount: 2,
  fallbackState: 'active',
  health: 'healthy',
});

describe('formatHookStatus', () => {
  it('emits stable JSON containing every hook collection field', () => {
    const output = formatHookStatus([status('gemini-cli'), status('codex')], true);

    expect(output).toBe(`${JSON.stringify([
      status('codex'),
      status('gemini-cli'),
    ], null, 2)}\n`);
  });

  it('renders the same fields for human-readable status output', () => {
    const output = formatHookStatus([status('claude-code')], false);

    expect(output).toContain('Claude Code');
    expect(output).toContain('package: installed');
    expect(output).toContain('trust: not-required');
    expect(output).toContain('runner: ready');
    expect(output).toContain('last event: 2026-07-20T12:00:00.000Z');
    expect(output).toContain('pending: 2');
    expect(output).toContain('fallback: active');
    expect(output).toContain('health: healthy');
  });
});

describe('collectHookStatus Claude package detection', () => {
  it('detects a marketplace-installed plugin via installed_plugins.json', () => {
    const claude = claudeStatus(baseDeps({
      exists: (path) => path === CACHE_DIR || path === CACHE_RUNNER,
      readFile: (path) => {
        if (path !== INSTALLED) throw new Error('ENOENT');
        return JSON.stringify({
          version: 2,
          plugins: {
            'superpowers@superpowers-marketplace': [{ installPath: '/other' }],
            'mcp-lens@mcplens-local': [{ installPath: CACHE_DIR }],
          },
        });
      },
    }));

    expect(claude.packageState).toBe('installed');
    expect(claude.runnerState).toBe('ready');
  });

  it('still detects the legacy drop-in plugin directory', () => {
    const legacyDir = join(HOME, '.claude', 'plugins', 'mcp-lens');
    const claude = claudeStatus(baseDeps({
      exists: (path) => path === legacyDir || path === join(legacyDir, 'scripts', 'hook-runner.mjs'),
    }));

    expect(claude.packageState).toBe('installed');
    expect(claude.runnerState).toBe('ready');
  });

  it('reports missing when neither legacy nor marketplace runner exists', () => {
    const claude = claudeStatus(baseDeps({
      readFile: (path) => {
        if (path !== INSTALLED) throw new Error('ENOENT');
        return JSON.stringify({ version: 2, plugins: {} });
      },
    }));

    expect(claude.packageState).toBe('missing');
    expect(claude.runnerState).toBe('missing');
  });
});

describe('collectHookStatus Codex package detection', () => {
  it('detects a marketplace-installed plugin under the versioned cache dir', () => {
    const codex = codexStatus(baseDeps({
      exists: (path) => path === CODEX_DIR || path === CODEX_RUNNER,
      readDirectory: (path) => {
        if (path === CODEX_CACHE) return ['mcplens-local'];
        if (path === join(CODEX_CACHE, 'mcplens-local', 'mcp-lens')) return ['0.1.0'];
        return [];
      },
    }));

    expect(codex.packageState).toBe('installed');
    expect(codex.runnerState).toBe('ready');
  });

  it('still detects the legacy drop-in plugin directory', () => {
    const legacyDir = join(HOME, '.codex', 'plugins', 'mcp-lens');
    const codex = codexStatus(baseDeps({
      exists: (path) => path === legacyDir || path === join(legacyDir, 'scripts', 'hook-runner.mjs'),
    }));

    expect(codex.packageState).toBe('installed');
    expect(codex.runnerState).toBe('ready');
  });

  it('reports missing when the cache holds no mcp-lens runner', () => {
    const codex = codexStatus(baseDeps({
      readDirectory: (path) => (path === CODEX_CACHE ? ['some-other-marketplace'] : []),
    }));

    expect(codex.packageState).toBe('missing');
    expect(codex.runnerState).toBe('missing');
  });
});
