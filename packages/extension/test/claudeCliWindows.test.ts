import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBinary, nvmCandidates, spawnSpec } from '../src/claudeCli.js';

// Windows 탐지는 개발자의 macOS/Linux 기기에서 실행되므로, 플랫폼·환경변수·홈을
// 주입해 재현한다. 실제 win32 커널 동작이 아니라 "이 경로/이 확장자를 후보로
// 만드는가"라는 순수 계산만 검증한다 — 그게 실제로 깨진 지점이다.
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

  it('PATH 디렉터리에서 PATHEXT 확장자가 붙은 실행 파일을 찾는다', () => {
    const dir = temp('mcplens-win-path-');
    const binPath = join(dir, 'gemini.cmd');
    writeFileSync(binPath, '@echo off\r\n');

    expect(findBinary('gemini', { platform: 'win32', env: WIN_ENV(dir), home: temp('mcplens-win-home-') }))
      .toBe(binPath);
  });

  it('PATH는 세미콜론으로 나눈다 (win32 구분자)', () => {
    const other = temp('mcplens-win-other-');
    const dir = temp('mcplens-win-path2-');
    const binPath = join(dir, 'codex.exe');
    writeFileSync(binPath, '');

    expect(findBinary('codex', {
      platform: 'win32', env: WIN_ENV(`${other};${dir}`), home: temp('mcplens-win-home2-'),
    })).toBe(binPath);
  });

  it('확장자 없는 npm sh 스크립트보다 .cmd를 우선한다 (spawn 가능한 쪽)', () => {
    const dir = temp('mcplens-win-prefer-');
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\n');       // npm이 같이 까는 sh 스크립트
    const cmd = join(dir, 'codex.cmd');
    writeFileSync(cmd, '@echo off\r\n');

    expect(findBinary('codex', { platform: 'win32', env: WIN_ENV(dir), home: temp('mcplens-win-prefer-home-') }))
      .toBe(cmd);
  });

  it('%USERPROFILE%\\.local\\bin 의 네이티브 설치(claude.exe)를 찾는다 — PATH에 없어도', () => {
    const home = temp('mcplens-win-native-');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const exe = join(home, '.local', 'bin', 'claude.exe');
    writeFileSync(exe, '');

    expect(findBinary('claude', { platform: 'win32', env: WIN_ENV(temp('mcplens-win-empty-')), home }))
      .toBe(exe);
  });

  it('%APPDATA%\\npm 의 전역 npm 설치를 찾는다 — PATH에 없어도', () => {
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

  it('POSIX 전용 후보(/opt/homebrew 등)는 win32에서 조회하지 않는다', () => {
    // 못 찾으면 null — POSIX 경로를 뒤지다 예외가 나거나 오탐하지 않는다.
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

  it('nvm-windows 레이아웃(<root>/<version>/<name>, bin 디렉터리 없음)을 만든다', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcplens-nvmwin-'));
    dirs.push(root);
    mkdirSync(join(root, 'v20.11.0'), { recursive: true });
    mkdirSync(join(root, 'v22.14.0'), { recursive: true });

    const candidates = nvmCandidates('codex', root, 'win32');
    expect(candidates).toContain(join(root, 'v20.11.0', 'codex'));
    expect(candidates).toContain(join(root, 'v22.14.0', 'codex'));
    // POSIX 레이아웃(versions/node/<v>/bin)은 win32에서 만들지 않는다.
    expect(candidates.some((c) => c.includes(join('versions', 'node')))).toBe(false);
  });
});

describe('spawnSpec', () => {
  it('win32의 .cmd 는 shell 경유로 실행한다 (Node 18.20.2+ 직접 spawn은 EINVAL)', () => {
    const spec = spawnSpec('C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd', ['plugin', 'list', '--json'], 'win32');
    expect(spec.options.shell).toBe(true);
  });

  it('shell 경유일 때 공백이 든 경로·인자를 인용한다', () => {
    const spec = spawnSpec('C:\\Program Files\\x\\claude.cmd', ['plugin', 'marketplace', 'add', 'C:\\Users\\a b\\.mcplens\\m'], 'win32');
    expect(spec.command).toBe('"C:\\Program Files\\x\\claude.cmd"');
    expect(spec.args).toContain('"C:\\Users\\a b\\.mcplens\\m"');
    expect(spec.args).toContain('plugin'); // 공백 없는 인자는 그대로
  });

  it('win32의 .exe 는 shell 없이 직접 spawn한다', () => {
    const spec = spawnSpec('C:\\Users\\a\\.local\\bin\\claude.exe', ['plugin', 'list'], 'win32');
    expect(spec.options.shell).toBeFalsy();
    expect(spec.command).toBe('C:\\Users\\a\\.local\\bin\\claude.exe');
    expect(spec.args).toEqual(['plugin', 'list']);
  });

  it('POSIX는 그대로 직접 spawn한다 — 인용도 shell도 없다', () => {
    const spec = spawnSpec('/usr/local/bin/claude', ['plugin', 'marketplace', 'add', '/home/a b/x'], 'darwin');
    expect(spec.options.shell).toBeFalsy();
    expect(spec.command).toBe('/usr/local/bin/claude');
    expect(spec.args).toEqual(['plugin', 'marketplace', 'add', '/home/a b/x']);
  });
});
