import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBinary, nvmCandidates, spawnSpec } from '../src/claudeCli.js';

// Windows detection runs on a developer's macOS/Linux machine, so platform, environment variables
// and home are injected to reproduce it. It verifies only the pure computation of "does this become
// a candidate path/extension", not real win32 kernel behaviour: that is what actually broke.
const WIN_ENV = (path: string) => ({ PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

describe('findBinary (win32)', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('finds an executable with a PATHEXT extension in a PATH directory', () => {
    const dir = temp('mcplens-win-path-');
    const binPath = join(dir, 'gemini.cmd');
    writeFileSync(binPath, '@echo off\r\n');

    expect(findBinary('gemini', { platform: 'win32', env: WIN_ENV(dir), home: temp('mcplens-win-home-') }))
      .toBe(binPath);
  });

  it('splits PATH on semicolons (the win32 separator)', () => {
    const other = temp('mcplens-win-other-');
    const dir = temp('mcplens-win-path2-');
    const binPath = join(dir, 'codex.exe');
    writeFileSync(binPath, '');

    expect(findBinary('codex', {
      platform: 'win32', env: WIN_ENV(`${other};${dir}`), home: temp('mcplens-win-home2-'),
    })).toBe(binPath);
  });

  it('prefers .cmd over the extensionless npm sh script (the spawnable one)', () => {
    const dir = temp('mcplens-win-prefer-');
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\n');       // the sh script npm installs alongside
    const cmd = join(dir, 'codex.cmd');
    writeFileSync(cmd, '@echo off\r\n');

    expect(findBinary('codex', { platform: 'win32', env: WIN_ENV(dir), home: temp('mcplens-win-prefer-home-') }))
      .toBe(cmd);
  });

  it('finds a native install (claude.exe) in %USERPROFILE%\\.local\\bin even when it is not on PATH', () => {
    const home = temp('mcplens-win-native-');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const exe = join(home, '.local', 'bin', 'claude.exe');
    writeFileSync(exe, '');

    expect(findBinary('claude', { platform: 'win32', env: WIN_ENV(temp('mcplens-win-empty-')), home }))
      .toBe(exe);
  });

  it('finds a global npm install in %APPDATA%\\npm even when it is not on PATH', () => {
    const appData = temp('mcplens-win-appdata-');
    mkdirSync(join(appData, 'npm'), { recursive: true });
    const cmd = join(appData, 'npm', 'gemini.cmd');
    writeFileSync(cmd, '@echo off\r\n');

    expect(findBinary('gemini', {
      platform: 'win32',
      env: { ...WIN_ENV(temp('mcplens-win-empty2-')), APPDATA: appData },
      home: temp('mcplens-win-home3-'),
    })).toBe(cmd);
  });

  it('never looks up POSIX-only candidates (/opt/homebrew and friends) on win32', () => {
    // null when nothing is found: it neither throws nor false-positives while walking POSIX paths.
    expect(findBinary('claude', {
      platform: 'win32', env: WIN_ENV(temp('mcplens-win-empty3-')), home: temp('mcplens-win-home4-'),
    })).toBeNull();
  });
});

describe('nvmCandidates (win32)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('builds the nvm-windows layout (<root>/<version>/<name>, no bin directory)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcplens-nvmwin-'));
    dirs.push(root);
    mkdirSync(join(root, 'v20.11.0'), { recursive: true });
    mkdirSync(join(root, 'v22.14.0'), { recursive: true });

    const candidates = nvmCandidates('codex', root, 'win32');
    expect(candidates).toContain(join(root, 'v20.11.0', 'codex'));
    expect(candidates).toContain(join(root, 'v22.14.0', 'codex'));
    // The POSIX layout (versions/node/<v>/bin) is not built on win32.
    expect(candidates.some((c) => c.includes(join('versions', 'node')))).toBe(false);
  });
});

describe('spawnSpec', () => {
  it('runs a win32 .cmd through the shell (direct spawn is EINVAL on Node 18.20.2+)', () => {
    const spec = spawnSpec('C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd', ['plugin', 'list', '--json'], 'win32');
    expect(spec.options.shell).toBe(true);
  });

  it('quotes paths and arguments containing spaces when going through the shell', () => {
    const spec = spawnSpec('C:\\Program Files\\x\\claude.cmd', ['plugin', 'marketplace', 'add', 'C:\\Users\\a b\\.mcplens\\m'], 'win32');
    expect(spec.command).toBe('"C:\\Program Files\\x\\claude.cmd"');
    expect(spec.args).toContain('"C:\\Users\\a b\\.mcplens\\m"');
    expect(spec.args).toContain('plugin'); // arguments without spaces stay as they are
  });

  it('spawns a win32 .exe directly, without a shell', () => {
    const spec = spawnSpec('C:\\Users\\a\\.local\\bin\\claude.exe', ['plugin', 'list'], 'win32');
    expect(spec.options.shell).toBeFalsy();
    expect(spec.command).toBe('C:\\Users\\a\\.local\\bin\\claude.exe');
    expect(spec.args).toEqual(['plugin', 'list']);
  });

  it('spawns directly on POSIX: no quoting and no shell', () => {
    const spec = spawnSpec('/usr/local/bin/claude', ['plugin', 'marketplace', 'add', '/home/a b/x'], 'darwin');
    expect(spec.options.shell).toBeFalsy();
    expect(spec.command).toBe('/usr/local/bin/claude');
    expect(spec.args).toEqual(['plugin', 'marketplace', 'add', '/home/a b/x']);
  });
});
