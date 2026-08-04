import { join } from 'node:path';
import { absent, BaseHookInstaller, msg } from './installers/base.js';

export interface RunResult { stdout: string; stderr: string; code: number; }

export type HookClient = 'claude-code' | 'codex' | 'gemini-cli';

export interface InstallerDeps {
  home: string;
  findBinary: (name: string) => string | null;
  run: (bin: string, args: string[]) => Promise<RunResult>;
  fs: {
    copyDir: (from: string, to: string) => void;
    exists: (path: string) => boolean;
    readDir: (path: string) => string[];
    /** 없거나 읽을 수 없으면 throw — 호출자가 fail-open으로 처리한다. */
    readFile: (path: string) => string;
    /** 상위 디렉터리가 없으면 만들고 쓴다. */
    writeFile: (path: string, content: string) => void;
  };
  bundledDir: string; // dist/<...> 번들 경로
}

export interface ClientHookInstaller {
  readonly client: HookClient;
  detect(): Promise<InstallState>;
  install(): Promise<InstallResult>;
  uninstall(): Promise<InstallResult>;
}

/**
 * `needs-approval`: 플러그인이 설치되고 `enabled = true`도 기록됐지만 codex의
 * `trusted_hash` 승인이 남은 상태. 훅은 아직 실행되지 않는다. 설치로는 해소할 수
 * 없고 사용자가 codex를 한 번 실행해 뜨는 동의를 승인해야 한다.
 */
export type InstallState = 'installed' | 'needs-approval' | 'not-installed' | 'client-missing';

export type InstallResult =
  | { kind: 'ok'; alreadyInstalled: boolean }
  | { kind: 'client-missing' }
  | { kind: 'failed'; step: string; stderr: string };

export function stableDir(home: string, sub: string): string {
  return join(home, '.mcplens', sub);
}

export const PLUGIN_ID = 'mcp-lens@mcplens';
export const MARKETPLACE_NAME = 'mcplens';

export class ClaudeHookInstaller extends BaseHookInstaller {
  readonly client = 'claude-code' as const;

  async detect(): Promise<InstallState> {
    const bin = this.bin('claude');
    if (bin === null) return 'client-missing';
    const r = await this.run(bin, ['plugin', 'list', '--json']);
    if (r.code === 0) {
      try {
        const arr: unknown = JSON.parse(r.stdout);
        const has = Array.isArray(arr) && arr.some((p) => (p as { id?: unknown })?.id === PLUGIN_ID);
        return has ? 'installed' : 'not-installed';
      } catch { return 'not-installed'; }
    }
    return 'not-installed';
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin('claude');
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };
    const target = stableDir(this.deps.home, 'claude-marketplace');
    try { this.deps.fs.copyDir(this.deps.bundledDir, target); }
    catch (e) { return { kind: 'failed', step: 'copy', stderr: msg(e) }; }
    const add = await this.run(bin, ['plugin', 'marketplace', 'add', target]);
    if (add.code !== 0 && !alreadyPresent(add.stderr)) return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
    const ins = await this.run(bin, ['plugin', 'install', PLUGIN_ID]);
    if (ins.code !== 0 && !alreadyPresent(ins.stderr)) return { kind: 'failed', step: 'install', stderr: ins.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin('claude');
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.run(bin, ['plugin', 'uninstall', PLUGIN_ID]);
    if (un.code !== 0 && !absent(un.stderr)) return { kind: 'failed', step: 'uninstall', stderr: un.stderr };
    await this.run(bin, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    return { kind: 'ok', alreadyInstalled: false };
  }
}

function alreadyPresent(s: string): boolean { return /already (exists|added|installed)/i.test(s); }
