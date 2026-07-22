import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { memFsStub } from './helpers/memFs.js';
import {
  bundledStamp,
  installedStamp,
  needsRuntimeRefresh,
  recordInstalledStamp,
  stampRecordPath,
} from '../src/runtimeFreshness.js';

const HOME = '/home/u';
const BUNDLE = '/ext/dist/claude-marketplace';
const STAMP_FILE = join(BUNDLE, 'mcp-lens', 'runtime', 'runtime-stamp.json');

describe('bundledStamp', () => {
  it('번들 런타임의 지문을 읽는다', () => {
    const fs = memFsStub({ [STAMP_FILE]: JSON.stringify({ stamp: 'abc123' }) });
    expect(bundledStamp(fs, BUNDLE, 'claude-code')).toBe('abc123');
  });

  it('파일이 없으면 null — 판정 불가일 뿐 오류가 아니다', () => {
    expect(bundledStamp(memFsStub(), BUNDLE, 'claude-code')).toBeNull();
  });

  it('깨진 JSON이어도 throw하지 않고 null', () => {
    const fs = memFsStub({ [STAMP_FILE]: '{ not json' });
    expect(bundledStamp(fs, BUNDLE, 'claude-code')).toBeNull();
  });
});

describe('installedStamp / recordInstalledStamp', () => {
  it('설치 시 기록한 지문을 클라이언트별로 되읽는다', () => {
    const fs = memFsStub();
    recordInstalledStamp(fs, HOME, 'claude-code', 'abc123');
    recordInstalledStamp(fs, HOME, 'codex', 'def456');

    expect(installedStamp(fs, HOME, 'claude-code')).toBe('abc123');
    expect(installedStamp(fs, HOME, 'codex')).toBe('def456');
    expect(installedStamp(fs, HOME, 'gemini-cli')).toBeNull();
  });

  it('한 클라이언트를 갱신해도 다른 클라이언트 기록은 보존된다', () => {
    const fs = memFsStub();
    recordInstalledStamp(fs, HOME, 'claude-code', 'old');
    recordInstalledStamp(fs, HOME, 'codex', 'keep');
    recordInstalledStamp(fs, HOME, 'claude-code', 'new');

    expect(installedStamp(fs, HOME, 'claude-code')).toBe('new');
    expect(installedStamp(fs, HOME, 'codex')).toBe('keep');
  });

  it('기록 파일이 깨져 있어도 throw하지 않고 새로 쓴다', () => {
    const fs = memFsStub({ [stampRecordPath(HOME)]: 'garbage' });
    recordInstalledStamp(fs, HOME, 'codex', 'x');
    expect(installedStamp(fs, HOME, 'codex')).toBe('x');
  });

  it('쓰기가 실패해도 예외를 전파하지 않는다 (설치를 막으면 안 된다)', () => {
    const fs = { ...memFsStub(), writeFile: () => { throw new Error('EACCES'); } };
    expect(() => recordInstalledStamp(fs, HOME, 'codex', 'x')).not.toThrow();
  });
});

describe('needsRuntimeRefresh', () => {
  it('설치돼 있고 지문이 다르면 갱신이 필요하다', () => {
    expect(needsRuntimeRefresh('installed', 'bundled-1', 'installed-0')).toBe(true);
  });

  it('지문이 같으면 갱신하지 않는다', () => {
    expect(needsRuntimeRefresh('installed', 'same', 'same')).toBe(false);
  });

  // 이번 사건의 실제 경로: 지문 개념이 없던 버전으로 설치된 사용자.
  it('설치 기록이 없으면(구버전으로 설치됨) 갱신이 필요하다', () => {
    expect(needsRuntimeRefresh('installed', 'bundled-1', null)).toBe(true);
  });

  it('훅이 설치돼 있지 않으면 갱신 대상이 아니다', () => {
    expect(needsRuntimeRefresh('not-installed', 'bundled-1', null)).toBe(false);
    expect(needsRuntimeRefresh('client-missing', 'bundled-1', null)).toBe(false);
  });

  // 번들 지문을 못 읽으면 비교 근거가 없다. 무작정 재설치하면 매 기동마다
  // 재설치를 반복할 수 있으므로 아무것도 하지 않는다.
  it('번들 지문을 읽을 수 없으면 갱신하지 않는다', () => {
    expect(needsRuntimeRefresh('installed', null, null)).toBe(false);
    expect(needsRuntimeRefresh('installed', null, 'installed-0')).toBe(false);
  });
});
