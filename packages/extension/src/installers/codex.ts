import { join } from 'node:path';
import type { InstallResult, InstallState } from '../hookInstall.js';
import { MARKETPLACE_NAME, PLUGIN_ID, stableDir } from '../hookInstall.js';
import { absent, BaseHookInstaller, msg } from './base.js';
import type { CodexHookState } from './codexHookState.js';
import { readCodexHookStates, withCodexHooksEnabled } from './codexHookState.js';

/** Measured schema of `codex plugin list --json` (codex-cli 0.144.6). */
interface CodexPluginEntry { pluginId?: string; installed?: boolean }
interface CodexPluginList { installed?: CodexPluginEntry[]; available?: CodexPluginEntry[] }

/**
 * Codex hook installer.
 *
 * Measured against codex-cli 0.144.6:
 * - Detect: `codex plugin list --json` returns `{ installed: [{ pluginId, installed, ... }], available: [] }`.
 *   Without `--available`, only actually installed plugins appear in `installed[]`.
 * - Install: `codex plugin marketplace add <snapshot path>`, then `codex plugin add mcp-lens@mcplens`.
 *   The `name` in the snapshot's `.agents/plugins/marketplace.json` becomes the marketplace name, and
 *   `<plugin name>@<marketplace name>` becomes the pluginId.
 * - Uninstall: `codex plugin remove <pluginId>`, then `codex plugin marketplace remove <marketplace name>`
 *   (it takes the name, not the path).
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
    // With an unreadable config there is no basis for a decision, so fail open (the never-throw principle of base.ts).
    // Leaning toward not-installed here would retry the install on every startup.
    if (states === null) return 'installed';
    // A missing enabled can be fixed by installing, so it returns to being an install target.
    if (!states.every((s) => s.enabled)) return 'not-installed';
    return states.every((s) => s.trusted) ? 'installed' : 'needs-approval';
  }

  /** null when unreadable; the caller handles it fail-open. */
  private readHookStates(): CodexHookState[] | null {
    try { return readCodexHookStates(this.deps.fs.readFile(this.configPath())); }
    catch { return null; }
  }

  private configPath(): string { return join(this.deps.home, '.codex', 'config.toml'); }

  async install(): Promise<InstallResult> {
    const bin = this.bin('codex');
    if (bin === null) return { kind: 'client-missing' };
    const before = await this.detect();
    // needs-approval cannot be advanced by installing: all that remains is user approval.
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
   * Writes `enabled = true` into config.toml. A backup is left before writing:
   * this is the user's CLI configuration, so there must be a basis for reverting (the store's `.mcplens.bak` convention).
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
    // Measured: removing a marketplace that is already gone exits 1. Removal is best effort, so the result is ignored.
    await this.run(bin, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    return { kind: 'ok', alreadyInstalled: false };
  }
}

function alreadyPresent(s: string): boolean { return /already (exists|added|installed)/i.test(s); }
