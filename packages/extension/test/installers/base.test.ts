import { memFsStub } from '../helpers/memFs.js';
import { describe, expect, it } from 'vitest';
import { absent, BaseHookInstaller } from '../../src/installers/base.js';
import type { InstallerDeps, InstallResult, InstallState } from '../../src/hookInstall.js';

const HOME = '/home/u';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: HOME,
    findBinary: () => '/bin/testclient',
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    fs: memFsStub(),
    bundledDir: '/bundle/testclient',
    ...over,
  };
}

/** Minimal concrete subclass exposing the protected mechanics for direct testing. */
class TestInstaller extends BaseHookInstaller {
  readonly client = 'claude-code' as const;
  async detect(): Promise<InstallState> { return 'not-installed'; }
  async install(): Promise<InstallResult> { return { kind: 'ok', alreadyInstalled: false }; }
  async uninstall(): Promise<InstallResult> { return { kind: 'ok', alreadyInstalled: false }; }

  async callRun(bin: string, args: string[]) { return this.run(bin, args); }
  callBin(name: string) { return this.bin(name); }
}

describe('BaseHookInstaller never-throw guarantees', () => {
  it('run() absorbs a rejecting deps.run into a non-zero RunResult instead of throwing', async () => {
    const installer = new TestInstaller(deps({
      run: async () => { throw new Error('boom'); },
    }));
    const result = await installer.callRun('/bin/testclient', ['some', 'args']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('boom');
    expect(result.stdout).toBe('');
  });

  it('bin() absorbs a throwing deps.findBinary into null instead of throwing', () => {
    const installer = new TestInstaller(deps({
      findBinary: () => { throw new Error('not found'); },
    }));
    expect(() => installer.callBin('testclient')).not.toThrow();
    expect(installer.callBin('testclient')).toBeNull();
  });

  it('run() passes through a resolving deps.run unchanged', async () => {
    const installer = new TestInstaller(deps({
      run: async () => ({ stdout: 'out', stderr: '', code: 0 }),
    }));
    const result = await installer.callRun('/bin/testclient', []);
    expect(result).toEqual({ stdout: 'out', stderr: '', code: 0 });
  });

  it('bin() passes through a resolving deps.findBinary unchanged', () => {
    const installer = new TestInstaller(deps({
      findBinary: (name) => `/usr/local/bin/${name}`,
    }));
    expect(installer.callBin('testclient')).toBe('/usr/local/bin/testclient');
  });
});

describe('absent', () => {
  it('claude의 "not found in installed plugins" 문구를 true로 판정한다', () => {
    expect(absent('Error: mcp-lens@mcplens not found in installed plugins')).toBe(true);
  });

  it('gemini의 \'Extension not found.\' 문구를 true로 판정한다', () => {
    expect(absent('Failed to uninstall "mcp-lens": Extension not found.')).toBe(true);
  });

  it('codex의 "not installed" / "no such" 문구를 true로 판정한다', () => {
    expect(absent('plugin is not installed')).toBe(true);
    expect(absent('no such plugin')).toBe(true);
  });

  it('무관한 에러는 false로 판정한다', () => {
    expect(absent('permission denied')).toBe(false);
  });
});
