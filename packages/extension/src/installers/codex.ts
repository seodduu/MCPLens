import type { InstallResult, InstallState } from '../hookInstall.js';
import { MARKETPLACE_NAME, PLUGIN_ID, stableDir } from '../hookInstall.js';
import { absent, BaseHookInstaller, msg } from './base.js';

/** `codex plugin list --json`의 실측 스키마 (codex-cli 0.144.6). */
interface CodexPluginEntry { pluginId?: string; installed?: boolean }
interface CodexPluginList { installed?: CodexPluginEntry[]; available?: CodexPluginEntry[] }

/**
 * Codex 훅 설치기.
 *
 * 실측 기준(codex-cli 0.144.6):
 * - 감지: `codex plugin list --json` → `{ installed: [{ pluginId, installed, ... }], available: [] }`.
 *   `--available` 없이는 실제 설치된 플러그인만 `installed[]`에 들어온다.
 * - 설치: `codex plugin marketplace add <스냅샷 경로>` → `codex plugin add mcp-lens@mcplens`.
 *   스냅샷의 `.agents/plugins/marketplace.json` 의 `name`이 마켓플레이스 이름이 되고,
 *   `<플러그인 이름>@<마켓플레이스 이름>`이 pluginId가 된다.
 * - 제거: `codex plugin remove <pluginId>` → `codex plugin marketplace remove <마켓플레이스 이름>`
 *   (경로가 아니라 이름을 받는다).
 */
export class CodexHookInstaller extends BaseHookInstaller {
  readonly client = 'codex' as const;

  async detect(): Promise<InstallState> {
    const bin = this.bin('codex');
    if (bin === null) return 'client-missing';
    const r = await this.run(bin, ['plugin', 'list', '--json']);
    if (r.code !== 0) return 'not-installed';
    try {
      const parsed = JSON.parse(r.stdout) as CodexPluginList;
      const has = (parsed.installed ?? []).some((p) => p.pluginId === PLUGIN_ID && p.installed !== false);
      return has ? 'installed' : 'not-installed';
    } catch { return 'not-installed'; }
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin('codex');
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };

    const target = stableDir(this.deps.home, 'codex-marketplace');
    try { this.deps.fs.copyDir(this.deps.bundledDir, target); }
    catch (e) { return { kind: 'failed', step: 'copy', stderr: msg(e) }; }

    const add = await this.run(bin, ['plugin', 'marketplace', 'add', target]);
    if (add.code !== 0 && !alreadyPresent(add.stderr)) {
      return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
    }
    const ins = await this.run(bin, ['plugin', 'add', PLUGIN_ID]);
    if (ins.code !== 0 && !alreadyPresent(ins.stderr)) {
      return { kind: 'failed', step: 'install', stderr: ins.stderr };
    }
    return { kind: 'ok', alreadyInstalled: false };
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin('codex');
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.run(bin, ['plugin', 'remove', PLUGIN_ID]);
    if (un.code !== 0 && !absent(un.stderr)) {
      return { kind: 'failed', step: 'uninstall', stderr: un.stderr };
    }
    // 마켓플레이스가 이미 없으면 실측상 exit 1 — 제거는 최선 노력으로 두고 결과를 무시한다.
    await this.run(bin, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    return { kind: 'ok', alreadyInstalled: false };
  }
}

function alreadyPresent(s: string): boolean { return /already (exists|added|installed)/i.test(s); }
