import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { GeminiHookInstaller } from '../../src/installers/gemini.js';
import type { InstallerDeps, RunResult } from '../../src/hookInstall.js';

const BUNDLE = '/bundle/gemini-extension';
const HOME = '/home/u';
const TRUST = join(HOME, '.gemini', 'trustedFolders.json');

/** 메모리 위에서만 동작하는 파일 시스템 — 테스트가 실 홈을 건드리지 않는다. */
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

// gemini-cli 0.51.0 실측: `extensions install <로컬경로> --consent --skip-settings` 는
// --consent가 있어도 "Do you trust the files in this folder? [y/N]" 프롬프트에서
// 무한 대기한다(stdin을 닫아도 종료되지 않음). 이 프롬프트를 건너뛰는 플래그는 없다.
// 유일한 비대화형 경로는 설치 전에 소스 폴더를 trustedFolders.json에 등록하는 것이다.
describe('GeminiHookInstaller.install — 폴더 신뢰 사전 등록', () => {
  it('trustedFolders.json이 없으면 번들 경로를 TRUST_FOLDER로 만들어 둔다', async () => {
    const fs = memFs();
    await new GeminiHookInstaller(deps({ ...recorder(), fs: fs.api })).install();

    expect(JSON.parse(fs.files.get(TRUST) ?? '{}')).toEqual({ [BUNDLE]: 'TRUST_FOLDER' });
  });

  it('기존 trustedFolders.json의 다른 항목을 보존한 채 병합한다', async () => {
    const fs = memFs({ [TRUST]: JSON.stringify({ '/work/proj': 'TRUST_FOLDER' }) });
    await new GeminiHookInstaller(deps({ ...recorder(), fs: fs.api })).install();

    expect(JSON.parse(fs.files.get(TRUST) ?? '{}')).toEqual({
      '/work/proj': 'TRUST_FOLDER',
      [BUNDLE]: 'TRUST_FOLDER',
    });
  });

  it('신뢰 등록은 install 실행보다 먼저 일어난다 — 순서가 뒤바뀌면 프롬프트에 걸린다', async () => {
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

  it('깨진 trustedFolders.json이어도 throw하지 않고 새로 쓴다', async () => {
    const fs = memFs({ [TRUST]: '{ not json' });
    const res = await new GeminiHookInstaller(deps({ ...recorder(), fs: fs.api })).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(JSON.parse(fs.files.get(TRUST) ?? '{}')).toEqual({ [BUNDLE]: 'TRUST_FOLDER' });
  });

  it('신뢰 파일을 쓸 수 없어도 설치를 중단하지 않는다 (fail-open)', async () => {
    const fs = memFs();
    const wrapped = { ...fs.api, writeFile: () => { throw new Error('EACCES'); } };
    const { calls, run } = recorder();
    const res = await new GeminiHookInstaller(deps({ run, fs: wrapped })).install();

    // 쓰기에 실패해도 설치는 시도한다 — 이미 신뢰된 폴더일 수도 있기 때문.
    expect(calls.some((a) => a.includes('install'))).toBe(true);
    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('이미 설치돼 있으면 신뢰 파일을 건드리지 않는다', async () => {
    const fs = memFs();
    const installed = JSON.stringify([{ name: 'mcp-lens' }]);
    const run = async (): Promise<RunResult> => ({ stdout: installed, stderr: '', code: 0 });
    await new GeminiHookInstaller(deps({ run, fs: fs.api })).install();

    expect(fs.files.has(TRUST)).toBe(false);
  });
});
