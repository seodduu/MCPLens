import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBinary, findClaudeBinary, nodeFs, nvmCandidates, runBin, runClaude } from '../src/claudeCli.js';

describe('findClaudeBinary', () => {
  it('returns null or a string without throwing', () => {
    const result = findClaudeBinary();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('runClaude', () => {
  it('resolves with captured stdout and exit code from an async spawn', async () => {
    const result = await runClaude(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result).toEqual({ stdout: 'ok', stderr: '', code: 0 });
  });

  it('resolves (never rejects) with a non-zero code when the binary is missing', async () => {
    const result = await runClaude('/no/such/claude-binary', ['plugin', 'list']);
    expect(result.code).not.toBe(0);
  });
});

describe('findBinary', () => {
  it('returns null for a binary that does not exist', () => {
    expect(findBinary('definitely-not-a-real-bin-xyz')).toBeNull();
  });

  describe('PATH scanning', () => {
    let dir: string | undefined;
    const originalPath = process.env.PATH;

    afterEach(() => {
      process.env.PATH = originalPath;
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('finds a binary on PATH for the exact given name, not a hardcoded one', () => {
      dir = mkdtempSync(join(tmpdir(), 'mcplens-findbin-'));
      const binName = 'mcplens-fake-cli-test';
      const binPath = join(dir, binName);
      writeFileSync(binPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;

      // Matches the requested name.
      expect(findBinary(binName)).toBe(binPath);
      // A different name in the very same PATH dir does not match — proves
      // the lookup is parameterized on `name`, not hardcoded to 'claude'.
      expect(findBinary('mcplens-fake-cli-other')).toBeNull();
    });
  });
});

describe('nvmCandidates', () => {
  // Uses a temp dir standing in for ~/.nvm — never touches the developer's
  // real nvm install.
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns an empty array (never throws) when the nvm root is missing or unreadable', () => {
    expect(nvmCandidates('codex', '/no/such/nvm-root')).toEqual([]);
  });

  it('builds candidates shaped ~/.nvm/versions/node/<version>/bin/<name> (not the current symlink)', () => {
    dir = mkdtempSync(join(tmpdir(), 'mcplens-nvm-'));
    mkdirSync(join(dir, 'versions', 'node', 'v24.14.1', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'versions', 'node', 'v20.11.0', 'bin'), { recursive: true });

    const candidates = nvmCandidates('codex', dir);
    expect(candidates).toContain(join(dir, 'versions', 'node', 'v24.14.1', 'bin', 'codex'));
    expect(candidates).toContain(join(dir, 'versions', 'node', 'v20.11.0', 'bin', 'codex'));
  });

  it('really finds the binary on an nvm candidate path even when findBinary points HOME at a temp directory', () => {
    // findBinary itself hardcodes join(homedir(), '.nvm'), so exercise the
    // real integration path via a redirected $HOME rather than the real one.
    const originalHome = process.env.HOME;
    dir = mkdtempSync(join(tmpdir(), 'mcplens-nvm-findbin-'));
    const binDir = join(dir, '.nvm', 'versions', 'node', 'v24.14.1', 'bin');
    mkdirSync(binDir, { recursive: true });
    const binName = 'mcplens-fake-nvm-cli';
    const binPath = join(binDir, binName);
    writeFileSync(binPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    try {
      process.env.HOME = dir;
      expect(findBinary(binName)).toBe(binPath);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe('runBin', () => {
  it('is the generic alias for the async spawn used by findBinary consumers', async () => {
    const result = await runBin(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result).toEqual({ stdout: 'ok', stderr: '', code: 0 });
  });
});

describe('nodeFs', () => {
  it('exists/readDir/copyDir operate on a real temp directory', () => {
    const src = mkdtempSync(join(tmpdir(), 'mcplens-nodefs-src-'));
    const destParent = mkdtempSync(join(tmpdir(), 'mcplens-nodefs-dest-'));
    const dest = join(destParent, 'copied');
    try {
      writeFileSync(join(src, 'file.txt'), 'content');

      expect(nodeFs.exists(src)).toBe(true);
      expect(nodeFs.exists(join(src, 'does-not-exist'))).toBe(false);
      expect(nodeFs.readDir(src)).toEqual(['file.txt']);

      nodeFs.copyDir(src, dest);
      expect(nodeFs.exists(join(dest, 'file.txt'))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(destParent, { recursive: true, force: true });
    }
  });
});
