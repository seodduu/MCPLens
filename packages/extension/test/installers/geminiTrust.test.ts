import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { GeminiHookInstaller } from '../../src/installers/gemini.js';
import type { InstallerDeps, RunResult } from '../../src/hookInstall.js';

const BUNDLE = '/bundle/gemini-extension';
const HOME = '/home/u';
const TRUST = join(HOME, '.gemini', 'trustedFolders.json');

/** In-memory-only file system, so the test never touches the real home directory. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    api: {
      copyDir: () => {},
      exists: (p: string) => files.has(p),
      readDir: () => [],
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: (p: string, content: string) => { files.set(p, content); },
    },
  };
}

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: HOME,
    findBinary: () => '/bin/gemini',
    run: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fs: memFs().api,
    bundledDir: BUNDLE,
    ...over,
  };
}

function recorder() {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args.includes('list')) return { stdout: '[]', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { calls, run };
}

// Measured with gemini-cli 0.51.0: `extensions install <local path> --consent --skip-settings`
// still waits forever at the "Do you trust the files in this folder? [y/N]" prompt even with
// --consent (closing stdin does not end it). There is no flag that skips this prompt.
// The only non-interactive path is registering the source folder in trustedFolders.json before installing.
describe('GeminiHookInstaller.install: pre-registering folder trust', () => {
  it('creates the bundle path as TRUST_FOLDER when trustedFolders.json is missing', async () => {
    const fs = memFs();
    await new GeminiHookInstaller(deps({ ...recorder(), fs: fs.api })).install();

    expect(JSON.parse(fs.files.get(TRUST) ?? '{}')).toEqual({ [BUNDLE]: 'TRUST_FOLDER' });
  });

  it('merges while preserving the other entries of an existing trustedFolders.json', async () => {
    const fs = memFs({ [TRUST]: JSON.stringify({ '/work/proj': 'TRUST_FOLDER' }) });
    await new GeminiHookInstaller(deps({ ...recorder(), fs: fs.api })).install();

    expect(JSON.parse(fs.files.get(TRUST) ?? '{}')).toEqual({
      '/work/proj': 'TRUST_FOLDER',
      [BUNDLE]: 'TRUST_FOLDER',
    });
  });

  it('registers trust before running install: reversing the order hits the prompt', async () => {
    const order: string[] = [];
    const fs = memFs();
    const wrapped = {
      ...fs.api,
      writeFile: (p: string, c: string) => { order.push('trust'); fs.api.writeFile(p, c); },
    };
    const run = async (_bin: string, args: string[]): Promise<RunResult> => {
      if (args.includes('install')) order.push('install');
      return { stdout: '[]', stderr: '', code: 0 };
    };
    await new GeminiHookInstaller(deps({ run, fs: wrapped })).install();

    expect(order).toEqual(['trust', 'install']);
  });

  it('rewrites a broken trustedFolders.json instead of throwing', async () => {
    const fs = memFs({ [TRUST]: '{ not json' });
    const res = await new GeminiHookInstaller(deps({ ...recorder(), fs: fs.api })).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(JSON.parse(fs.files.get(TRUST) ?? '{}')).toEqual({ [BUNDLE]: 'TRUST_FOLDER' });
  });

  it('does not abort the install when the trust file cannot be written (fail-open)', async () => {
    const fs = memFs();
    const wrapped = { ...fs.api, writeFile: () => { throw new Error('EACCES'); } };
    const { calls, run } = recorder();
    const res = await new GeminiHookInstaller(deps({ run, fs: wrapped })).install();

    // The install is attempted even when the write fails: the folder may already be trusted.
    expect(calls.some((a) => a.includes('install'))).toBe(true);
    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('does not touch the trust file when it is already installed', async () => {
    const fs = memFs();
    const installed = JSON.stringify([{ name: 'mcp-lens' }]);
    const run = async (): Promise<RunResult> => ({ stdout: installed, stderr: '', code: 0 });
    await new GeminiHookInstaller(deps({ run, fs: fs.api })).install();

    expect(fs.files.has(TRUST)).toBe(false);
  });
});
