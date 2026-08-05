import { memFsStub } from '../helpers/memFs.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiHookInstaller, GEMINI_EXT_NAME } from '../../src/installers/gemini.js';
import type { InstallerDeps, RunResult } from '../../src/hookInstall.js';

const here = join(fileURLToPath(import.meta.url), '..');
/** Measured `gemini extensions list -o json` output (gemini-cli 0.51.0, only the home path anonymized). */
const listJson = readFileSync(join(here, '../fixtures/gemini-extensions-list.json'), 'utf8');
/** Measured: the output when nothing is installed is exactly an empty array. */
const emptyJson = '[]';

const BUNDLE = '/bundle/gemini-extension';

// Spawned without a TTY, gemini-cli 0.51.0 sends `-o json` output to stderr rather than stdout
// (code=0, empty stdout). The extension always spawns without a TTY, so this is the real path.
const listOnStderr = (json: string): RunResult => ({ stdout: '', stderr: json, code: 0 });

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: '/home/u',
    findBinary: () => '/bin/gemini',
    run: async () => ({ stdout: listJson, stderr: '', code: 0 }),
    fs: memFsStub(),
    bundledDir: BUNDLE,
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

describe('GeminiHookInstaller.detect', () => {
  it('reports installed when the measured fixture contains mcp-lens', async () => {
    expect(await new GeminiHookInstaller(deps()).detect()).toBe('installed');
  });

  it('reports not-installed for an empty array', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: emptyJson, stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('detects installed when the JSON arrives on stderr rather than stdout (non-TTY spawn)', async () => {
    const run = async (): Promise<RunResult> => listOnStderr(listJson);
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('installed');
  });

  it('reports not-installed when stderr holds an empty array (non-TTY spawn)', async () => {
    const run = async (): Promise<RunResult> => listOnStderr('[]');
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed when only other extensions are present', async () => {
    const stdout = JSON.stringify([{ name: 'some-other-ext', version: '2.0.0' }]);
    const run = async (): Promise<RunResult> => ({ stdout, stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('calls list with -o json (the flag that measurably exists)', async () => {
    const { calls, run } = recorder();
    await new GeminiHookInstaller(deps({ run })).detect();
    expect(calls).toEqual([['extensions', 'list', '-o', 'json']]);
  });

  it('finds the gemini binary by name', async () => {
    const asked: string[] = [];
    const findBinary = (n: string): string | null => { asked.push(n); return '/bin/gemini'; };
    await new GeminiHookInstaller(deps({ findBinary })).detect();
    expect(asked).toEqual(['gemini']);
  });

  it('reports client-missing when the binary is absent', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).detect()).toBe('client-missing');
  });

  it('treats a throwing findBinary as client-missing without propagating', async () => {
    const findBinary = (): never => { throw new Error('boom'); };
    const inst = new GeminiHookInstaller(deps({ findBinary }));
    expect(await inst.detect()).toBe('client-missing');
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('reports not-installed without throwing on non-JSON output', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: 'No extensions installed.', stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed when the output is a wrapper object rather than an array', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '{"extensions":[]}', stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed on a non-zero exit code', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: listJson, stderr: 'boom', code: 2 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('reports not-installed without propagating when run throws', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });
});

describe('GeminiHookInstaller.install', () => {
  it('passes the bundle path straight to extensions install (no copy step)', async () => {
    const { calls, run } = recorder();
    let copies = 0;
    const fs = { copyDir: () => { copies += 1; }, exists: () => false, readDir: () => [] };
    const res = await new GeminiHookInstaller(deps({ run, fs })).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(copies).toBe(0);
    expect(calls.filter((a) => !a.includes('list'))).toEqual([
      ['extensions', 'install', BUNDLE, '--consent', '--skip-settings'],
    ]);
  });

  it('always includes --consent: measured, without it the interactive prompt stalls', async () => {
    const { calls, run } = recorder();
    await new GeminiHookInstaller(deps({ run })).install();
    const install = calls.find((a) => a.includes('install'));
    expect(install).toContain('--consent');
  });

  it('returns alreadyInstalled early and never runs install when it is already installed', async () => {
    const { calls, run } = recorder(listJson);
    expect(await new GeminiHookInstaller(deps({ run })).install()).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(calls.filter((a) => !a.includes('list'))).toEqual([]);
  });

  it('reports client-missing when the binary is absent', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).install()).toEqual({ kind: 'client-missing' });
  });

  it('reports failed with step=install when install fails', async () => {
    const { run } = recorder(emptyJson, { stderr: 'Failed to install: bad manifest', code: 1 });
    expect(await new GeminiHookInstaller(deps({ run })).install())
      .toEqual({ kind: 'failed', step: 'install', stderr: 'Failed to install: bad manifest' });
  });

  it('treats the measured already-installed message as alreadyInstalled rather than a failure', async () => {
    // Measured: exit 1 + stderr `Extension "mcp-lens" is already installed. Please uninstall it first.`
    // Even when detect() returned not-installed from a stale or failed list, an install that reports
    // it is already installed must be recorded as alreadyInstalled: true, not a fresh install.
    const { run } = recorder(emptyJson, {
      stderr: 'Extension "mcp-lens" is already installed. Please uninstall it first.',
      code: 1,
    });
    expect(await new GeminiHookInstaller(deps({ run })).install()).toEqual({ kind: 'ok', alreadyInstalled: true });
  });

  it('returns failed without propagating when run throws', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      throw new Error('spawn ENOENT');
    };
    expect(await new GeminiHookInstaller(deps({ run })).install())
      .toEqual({ kind: 'failed', step: 'install', stderr: 'spawn ENOENT' });
  });
});

describe('GeminiHookInstaller.uninstall', () => {
  it('runs extensions uninstall with the extension name', async () => {
    const { calls, run } = recorder();
    expect(await new GeminiHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls).toEqual([['extensions', 'uninstall', GEMINI_EXT_NAME]]);
  });

  it('reports client-missing when the binary is absent', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('does not treat the measured not-installed message as a failure', async () => {
    // Measured: exit 1 + stderr `Failed to uninstall "mcp-lens": Extension not found.`
    const run = async (): Promise<RunResult> => ({
      stdout: '',
      stderr: 'Failed to uninstall "mcp-lens": Extension not found.',
      code: 1,
    });
    expect(await new GeminiHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('reports failed with step=uninstall for any other failure', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '', stderr: 'permission denied', code: 1 });
    expect(await new GeminiHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'permission denied' });
  });

  it('does not propagate when run throws', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new GeminiHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'spawn ENOENT' });
  });
});

describe('the gemini-extension manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(here, '../../../gemini-extension/gemini-extension.json'), 'utf8'),
  ) as { name: string };

  it('matches the manifest name with the extension name used for detection', () => {
    expect(manifest.name).toBe(GEMINI_EXT_NAME);
  });
});
