import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiHookInstaller, GEMINI_EXT_NAME } from '../../src/installers/gemini.js';
import type { InstallerDeps, RunResult } from '../../src/hookInstall.js';

const here = join(fileURLToPath(import.meta.url), '..');
/** `gemini extensions list -o json` 실측 출력 (gemini-cli 0.51.0, 홈 경로만 익명화). */
const listJson = readFileSync(join(here, '../fixtures/gemini-extensions-list.json'), 'utf8');
/** 실측상 미설치 상태의 출력은 정확히 빈 배열이다. */
const emptyJson = '[]';

const BUNDLE = '/bundle/gemini-extension';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: '/home/u',
    findBinary: () => '/bin/gemini',
    run: async () => ({ stdout: listJson, stderr: '', code: 0 }),
    fs: { copyDir: () => {}, exists: () => false, readDir: () => [] },
    bundledDir: BUNDLE,
    ...over,
  };
}

/** 호출 인자를 기록하고, list에는 지정한 JSON을, 나머지엔 성공을 돌려주는 run. */
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
  it('실측 픽스처에 mcp-lens가 있으면 installed', async () => {
    expect(await new GeminiHookInstaller(deps()).detect()).toBe('installed');
  });

  it('빈 배열이면 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: emptyJson, stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('다른 확장만 있으면 not-installed', async () => {
    const stdout = JSON.stringify([{ name: 'some-other-ext', version: '2.0.0' }]);
    const run = async (): Promise<RunResult> => ({ stdout, stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('list는 -o json으로 호출한다 (실측상 존재하는 플래그)', async () => {
    const { calls, run } = recorder();
    await new GeminiHookInstaller(deps({ run })).detect();
    expect(calls).toEqual([['extensions', 'list', '-o', 'json']]);
  });

  it('gemini 바이너리를 이름으로 찾는다', async () => {
    const asked: string[] = [];
    const findBinary = (n: string): string | null => { asked.push(n); return '/bin/gemini'; };
    await new GeminiHookInstaller(deps({ findBinary })).detect();
    expect(asked).toEqual(['gemini']);
  });

  it('바이너리가 없으면 client-missing', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).detect()).toBe('client-missing');
  });

  it('findBinary가 throw해도 전파하지 않고 client-missing으로 취급한다', async () => {
    const findBinary = (): never => { throw new Error('boom'); };
    const inst = new GeminiHookInstaller(deps({ findBinary }));
    expect(await inst.detect()).toBe('client-missing');
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('JSON이 아닌 출력이어도 throw하지 않고 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: 'No extensions installed.', stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('출력이 배열이 아닌 래퍼 객체여도 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '{"extensions":[]}', stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('종료 코드가 0이 아니면 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: listJson, stderr: 'boom', code: 2 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('run이 throw해도 전파하지 않고 not-installed', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });
});

describe('GeminiHookInstaller.install', () => {
  it('번들 경로를 그대로 extensions install에 넘긴다 (복사 단계 없음)', async () => {
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

  it('실측상 --consent 없이는 대화형 프롬프트에서 멈추므로 반드시 포함한다', async () => {
    const { calls, run } = recorder();
    await new GeminiHookInstaller(deps({ run })).install();
    const install = calls.find((a) => a.includes('install'));
    expect(install).toContain('--consent');
  });

  it('이미 설치돼 있으면 alreadyInstalled로 조기 반환하고 install을 실행하지 않는다', async () => {
    const { calls, run } = recorder(listJson);
    expect(await new GeminiHookInstaller(deps({ run })).install()).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(calls.filter((a) => !a.includes('list'))).toEqual([]);
  });

  it('바이너리가 없으면 client-missing', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).install()).toEqual({ kind: 'client-missing' });
  });

  it('install이 실패하면 step=install로 failed', async () => {
    const { run } = recorder(emptyJson, { stderr: 'Failed to install: bad manifest', code: 1 });
    expect(await new GeminiHookInstaller(deps({ run })).install())
      .toEqual({ kind: 'failed', step: 'install', stderr: 'Failed to install: bad manifest' });
  });

  it('이미 설치돼 있다는 실측 메시지는 실패로 보지 않고 alreadyInstalled로 보고한다', async () => {
    // 실측: exit 1 + stderr `Extension "mcp-lens" is already installed. Please uninstall it first.`
    // detect()가 stale/failed list 때문에 not-installed를 반환했더라도, install이 이미 설치됨을
    // 보고하면 신규 설치가 아니라 alreadyInstalled: true로 반영해야 한다.
    const { run } = recorder(emptyJson, {
      stderr: 'Extension "mcp-lens" is already installed. Please uninstall it first.',
      code: 1,
    });
    expect(await new GeminiHookInstaller(deps({ run })).install()).toEqual({ kind: 'ok', alreadyInstalled: true });
  });

  it('run이 throw해도 전파하지 않고 failed를 돌려준다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      throw new Error('spawn ENOENT');
    };
    expect(await new GeminiHookInstaller(deps({ run })).install())
      .toEqual({ kind: 'failed', step: 'install', stderr: 'spawn ENOENT' });
  });
});

describe('GeminiHookInstaller.uninstall', () => {
  it('확장 이름으로 extensions uninstall을 실행한다', async () => {
    const { calls, run } = recorder();
    expect(await new GeminiHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls).toEqual([['extensions', 'uninstall', GEMINI_EXT_NAME]]);
  });

  it('바이너리가 없으면 client-missing', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('설치돼 있지 않다는 실측 메시지는 실패로 보지 않는다', async () => {
    // 실측: exit 1 + stderr `Failed to uninstall "mcp-lens": Extension not found.`
    const run = async (): Promise<RunResult> => ({
      stdout: '',
      stderr: 'Failed to uninstall "mcp-lens": Extension not found.',
      code: 1,
    });
    expect(await new GeminiHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('그 밖의 실패는 step=uninstall로 failed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '', stderr: 'permission denied', code: 1 });
    expect(await new GeminiHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'permission denied' });
  });

  it('run이 throw해도 전파하지 않는다', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new GeminiHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'spawn ENOENT' });
  });
});

describe('gemini-extension 매니페스트', () => {
  const manifest = JSON.parse(
    readFileSync(join(here, '../../../gemini-extension/gemini-extension.json'), 'utf8'),
  ) as { name: string };

  it('매니페스트 이름이 감지에 쓰는 확장명과 일치한다', () => {
    expect(manifest.name).toBe(GEMINI_EXT_NAME);
  });
});
