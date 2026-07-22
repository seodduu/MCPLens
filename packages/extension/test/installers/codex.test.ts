import { memFsStub } from '../helpers/memFs.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexHookInstaller } from '../../src/installers/codex.js';
import { PLUGIN_ID, MARKETPLACE_NAME, stableDir, type InstallerDeps, type RunResult } from '../../src/hookInstall.js';

const here = join(fileURLToPath(import.meta.url), '..');
/** `codex plugin list --json` 실측 출력 (codex-cli 0.144.6). */
const listJson = readFileSync(join(here, '../fixtures/codex-plugin-list.json'), 'utf8');
/** mcp-lens가 없는 상태 — 실측상 미설치 플러그인은 installed[]에 아예 없다. */
const emptyJson = JSON.stringify({ installed: [], available: [] });

const HOME = '/home/u';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: HOME,
    findBinary: () => '/bin/codex',
    run: async () => ({ stdout: listJson, stderr: '', code: 0 }),
    fs: memFsStub(),
    bundledDir: '/bundle/codex-marketplace',
    ...over,
  };
}

/** 호출된 인자를 기록하고, list에는 지정한 JSON을, 나머지엔 성공을 돌려주는 run. */
function recorder(listOut = emptyJson, rest: Partial<RunResult> = {}) {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args.includes('list')) return { stdout: listOut, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0, ...rest };
  };
  return { calls, run };
}

describe('CodexHookInstaller.detect', () => {
  it('실측 픽스처에 mcp-lens@mcplens가 있으면 installed', async () => {
    expect(await new CodexHookInstaller(deps()).detect()).toBe('installed');
  });

  it('installed[]에 없으면 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: emptyJson, stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('엔트리가 installed:false면 not-installed', async () => {
    const stdout = JSON.stringify({
      installed: [{ pluginId: PLUGIN_ID, name: 'mcp-lens', marketplaceName: 'mcplens', installed: false }],
      available: [],
    });
    const run = async (): Promise<RunResult> => ({ stdout, stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('바이너리가 없으면 client-missing', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).detect()).toBe('client-missing');
  });

  it('findBinary가 throw해도 전파하지 않고 client-missing으로 취급한다', async () => {
    const findBinary = (): never => { throw new Error('boom'); };
    const inst = new CodexHookInstaller(deps({ findBinary }));
    expect(await inst.detect()).toBe('client-missing');
    expect(await inst.install()).toEqual({ kind: 'client-missing' });
    expect(await inst.uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('codex 바이너리를 이름으로 찾는다', async () => {
    const asked: string[] = [];
    const findBinary = (n: string): string | null => { asked.push(n); return '/bin/codex'; };
    await new CodexHookInstaller(deps({ findBinary })).detect();
    expect(asked).toEqual(['codex']);
  });

  it('JSON이 깨져 있으면 throw하지 않고 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: 'not json {{', stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('종료 코드가 0이 아니면 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: listJson, stderr: 'boom', code: 2 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });

  it('run이 throw해도 전파하지 않고 not-installed', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });
});

describe('CodexHookInstaller.install', () => {
  it('스냅샷 복사 → marketplace add → plugin add 순서로 실행', async () => {
    const copied: [string, string][] = [];
    const { calls, run } = recorder();
    const d = deps({ run, fs: { ...memFsStub(), copyDir: (f: string, t: string) => { copied.push([f, t]); } } });
    const res = await new CodexHookInstaller(d).install();

    expect(res).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(copied).toEqual([['/bundle/codex-marketplace', stableDir(HOME, 'codex-marketplace')]]);
    const mutations = calls.filter((a) => !a.includes('list'));
    expect(mutations).toEqual([
      ['plugin', 'marketplace', 'add', stableDir(HOME, 'codex-marketplace')],
      ['plugin', 'add', PLUGIN_ID],
    ]);
  });

  it('이미 설치돼 있으면 alreadyInstalled로 조기 반환하고 아무것도 실행하지 않는다', async () => {
    const { calls, run } = recorder(listJson);
    let copies = 0;
    const d = deps({ run, fs: { ...memFsStub(), copyDir: () => { copies += 1; } } });

    expect(await new CodexHookInstaller(d).install()).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(copies).toBe(0);
    expect(calls.filter((a) => !a.includes('list'))).toEqual([]);
  });

  it('바이너리가 없으면 client-missing', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).install()).toEqual({ kind: 'client-missing' });
  });

  it('복사가 실패하면 step=copy로 failed', async () => {
    const { run } = recorder();
    const fs = { copyDir: () => { throw new Error('EACCES'); }, exists: () => false, readDir: () => [] };
    expect(await new CodexHookInstaller(deps({ run, fs })).install())
      .toEqual({ kind: 'failed', step: 'copy', stderr: 'EACCES' });
  });

  it('marketplace add가 실패하면 step=marketplace-add로 failed하고 plugin add는 실행하지 않는다', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a);
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      return { stdout: '', stderr: 'bad manifest', code: 1 };
    };
    const res = await new CodexHookInstaller(deps({ run })).install();
    expect(res).toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'bad manifest' });
    expect(calls.some((a) => a.includes('add') && a.includes(PLUGIN_ID))).toBe(false);
  });

  it('plugin add가 실패하면 step=install로 failed', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      if (a.includes('marketplace')) return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: 'no such plugin', code: 1 };
    };
    expect(await new CodexHookInstaller(deps({ run })).install())
      .toEqual({ kind: 'failed', step: 'install', stderr: 'no such plugin' });
  });

  it('이미 추가됨 메시지는 실패로 보지 않는다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      return { stdout: '', stderr: 'Marketplace `mcplens` is already added', code: 1 };
    };
    expect(await new CodexHookInstaller(deps({ run })).install()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('run이 throw해도 전파하지 않고 failed를 돌려준다', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      if (a.includes('list')) return { stdout: emptyJson, stderr: '', code: 0 };
      throw new Error('spawn ENOENT');
    };
    const res = await new CodexHookInstaller(deps({ run })).install();
    expect(res).toEqual({ kind: 'failed', step: 'marketplace-add', stderr: 'spawn ENOENT' });
  });
});

describe('CodexHookInstaller.uninstall', () => {
  it('plugin remove → marketplace remove 순서로 실행', async () => {
    const { calls, run } = recorder();
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls).toEqual([
      ['plugin', 'remove', PLUGIN_ID],
      ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
    ]);
  });

  it('바이너리가 없으면 client-missing', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).uninstall()).toEqual({ kind: 'client-missing' });
  });

  it('plugin remove가 실패하면 step=uninstall로 failed하고 marketplace remove는 건너뛴다', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a);
      return { stdout: '', stderr: 'permission denied', code: 1 };
    };
    expect(await new CodexHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'permission denied' });
    expect(calls.some((a) => a.includes('marketplace'))).toBe(false);
  });

  it('설치돼 있지 않다는 메시지는 실패로 보지 않는다', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '', stderr: 'plugin is not installed', code: 1 });
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('marketplace remove 실패는 무시한다 (실측상 미설정이면 exit 1)', async () => {
    const run = async (_b: string, a: string[]): Promise<RunResult> => a.includes('marketplace')
      ? { stdout: '', stderr: 'marketplace `mcplens` is not configured or installed', code: 1 }
      : { stdout: '', stderr: '', code: 0 };
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });

  it('run이 throw해도 전파하지 않는다', async () => {
    const run = async (): Promise<RunResult> => { throw new Error('spawn ENOENT'); };
    expect(await new CodexHookInstaller(deps({ run })).uninstall())
      .toEqual({ kind: 'failed', step: 'uninstall', stderr: 'spawn ENOENT' });
  });

  it('"not found" 메시지도 실패로 보지 않는다', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '', stderr: 'plugin not found', code: 1 });
    expect(await new CodexHookInstaller(deps({ run })).uninstall()).toEqual({ kind: 'ok', alreadyInstalled: false });
  });
});

describe('codex-marketplace.json 에셋', () => {
  const manifest = JSON.parse(
    readFileSync(join(here, '../../assets/codex-marketplace.json'), 'utf8'),
  ) as { name: string; plugins: { name: string; source: { source: string; path: string } }[] };

  it('마켓플레이스 이름과 플러그인 이름이 PLUGIN_ID를 만들어낸다', () => {
    expect(manifest.name).toBe(MARKETPLACE_NAME);
    expect(`${manifest.plugins[0].name}@${manifest.name}`).toBe(PLUGIN_ID);
  });

  it('플러그인 소스는 스냅샷 상대 경로 ./plugins/mcp-lens', () => {
    expect(manifest.plugins[0].source).toEqual({ source: 'local', path: './plugins/mcp-lens' });
  });
});
