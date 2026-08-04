import { join } from 'node:path';
import type { InstallResult, InstallState } from '../hookInstall.js';
import { MARKETPLACE_NAME, PLUGIN_ID, stableDir } from '../hookInstall.js';
import { absent, BaseHookInstaller, msg } from './base.js';
import type { CodexHookState } from './codexHookState.js';
import { readCodexHookStates, withCodexHooksEnabled } from './codexHookState.js';

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
    let present = false;
    try {
      const parsed = JSON.parse(r.stdout) as CodexPluginList;
      present = (parsed.installed ?? []).some(
        (p) => p.pluginId === PLUGIN_ID && p.installed !== false);
    } catch { return 'not-installed'; }
    if (!present) return 'not-installed';

    const states = this.readHookStates();
    // config를 못 읽으면 판단 근거가 없다 — fail-open(base.ts의 never-throw 원칙).
    // 여기서 not-installed로 기울면 매 기동마다 재설치를 시도하게 된다.
    if (states === null) return 'installed';
    // enabled가 빠졌으면 설치로 고칠 수 있다 → 설치 대상으로 되돌린다.
    if (!states.every((s) => s.enabled)) return 'not-installed';
    return states.every((s) => s.trusted) ? 'installed' : 'needs-approval';
  }

  /** 읽을 수 없으면 null — 호출자가 fail-open으로 처리한다. */
  private readHookStates(): CodexHookState[] | null {
    try { return readCodexHookStates(this.deps.fs.readFile(this.configPath())); }
    catch { return null; }
  }

  private configPath(): string { return join(this.deps.home, '.codex', 'config.toml'); }

  async install(): Promise<InstallResult> {
    const bin = this.bin('codex');
    if (bin === null) return { kind: 'client-missing' };
    const before = await this.detect();
    // needs-approval은 설치로 더 나아갈 수 없다 — 남은 것은 사용자 승인뿐이다.
    if (before === 'installed' || before === 'needs-approval') {
      return { kind: 'ok', alreadyInstalled: true };
    }

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
    const enabled = this.enableHooks();
    if (!enabled.ok) return { kind: 'failed', step: 'enable-hooks', stderr: enabled.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }

  /**
   * config.toml에 `enabled = true`를 기록한다. 쓰기 전에 백업을 남긴다 —
   * 사용자 CLI 설정이므로 되돌릴 근거를 남겨야 한다(저장소의 `.mcplens.bak` 관례).
   */
  private enableHooks(): { ok: true } | { ok: false; stderr: string } {
    const path = this.configPath();
    try {
      const current = this.deps.fs.exists(path) ? this.deps.fs.readFile(path) : '';
      const next = withCodexHooksEnabled(current);
      if (next === current) return { ok: true };
      if (current !== '') this.deps.fs.writeFile(`${path}.mcplens.bak`, current);
      this.deps.fs.writeFile(path, next);
      return { ok: true };
    } catch (e) { return { ok: false, stderr: msg(e) }; }
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
