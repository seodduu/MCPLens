import { join } from 'node:path';
import type { InstallResult, InstallState } from '../hookInstall.js';
import { absent, BaseHookInstaller } from './base.js';

/** Must match the `name` in `packages/gemini-extension/gemini-extension.json`. */
export const GEMINI_EXT_NAME = 'mcp-lens';

/** Measured schema of `gemini extensions list -o json` (gemini-cli 0.51.0): the entries are objects. */
interface GeminiExtensionEntry { name?: string }

/**
 * Gemini CLI hook installer.
 *
 * Measured against gemini-cli 0.51.0:
 * - Detect: `gemini extensions list -o json` returns a top-level array of `{ name, version, path, ... }` objects.
 *   The output when nothing is installed is exactly `[]`. (`-o|--output-format` accepts only `text`|`json`.)
 * - Install: `gemini extensions install <source>`, where source is a git URL or a **local path positional**.
 *   There is no marketplace concept, so the bundle directory is passed as is (no copy step).
 *   Without `--consent`, an extension containing hooks **waits forever** at the `Do you want to continue? [Y/n]` prompt.
 *   Non-interactive execution is a given, so `--consent` and `--skip-settings` are passed together.
 * - Uninstall: `gemini extensions uninstall <name>` takes the extension name, not the path.
 *   When nothing is installed it exits 1 with stderr `Failed to uninstall "mcp-lens": Extension not found.`
 */
export class GeminiHookInstaller extends BaseHookInstaller {
  readonly client = 'gemini-cli' as const;

  async detect(): Promise<InstallState> {
    const bin = this.bin('gemini');
    if (bin === null) return 'client-missing';
    const r = await this.run(bin, ['extensions', 'list', '-o', 'json']);
    if (r.code !== 0) return 'not-installed';
    try {
      // Spawned without a TTY, gemini-cli 0.51.0 sends `-o json` output to stderr rather than stdout
      // (stdout is empty). The extension always spawns without a TTY, so the stderr fallback is the real path.
      const raw = r.stdout.trim() !== '' ? r.stdout : r.stderr;
      const parsed: unknown = JSON.parse(raw);
      const has = Array.isArray(parsed)
        && (parsed as GeminiExtensionEntry[]).some((e) => e?.name === GEMINI_EXT_NAME);
      return has ? 'installed' : 'not-installed';
    } catch { return 'not-installed'; }
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin('gemini');
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };

    // Even with --consent one more prompt remains: a local-path install raises "Do you trust the
    // files in this folder? [y/N]" and there is no flag to disable it (measured with 0.51.0
    // `extensions install --help`). Closing stdin does not end it either, so the only
    // non-interactive path is to add the source folder to the trust list first. It must precede install.
    this.trustBundledDir();

    // --consent is required or `gemini extensions install` blocks on an
    // interactive [Y/n] prompt and hangs forever, even with stdin closed
    // (measured on gemini-cli 0.51.0) — see class JSDoc above.
    const ins = await this.run(bin, ['extensions', 'install', this.deps.bundledDir, '--consent', '--skip-settings']);
    if (ins.code !== 0 && !alreadyInstalled(ins.stderr)) {
      return { kind: 'failed', step: 'install', stderr: ins.stderr };
    }
    // detect() may have missed a stale/failed `list`; if install then reports
    // the plugin is already there, reflect that instead of claiming a fresh
    // install happened (unlike Claude/Codex, where the alreadyPresent match
    // is about the marketplace, not the plugin itself).
    if (ins.code !== 0 && alreadyInstalled(ins.stderr)) {
      return { kind: 'ok', alreadyInstalled: true };
    }
    return { kind: 'ok', alreadyInstalled: false };
  }

  /**
   * Registers the bundle directory in `~/.gemini/trustedFolders.json`. Only the one directory we ship
   * is targeted and every other entry is preserved. Failures are swallowed: the folder may already be
   * trusted, and this step must never block the install (fail-open).
   */
  private trustBundledDir(): void {
    const path = join(this.deps.home, '.gemini', 'trustedFolders.json');
    try {
      let trusted: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(this.deps.fs.readFile(path));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          trusted = parsed as Record<string, string>;
        }
      } catch {
        // The file is missing or broken: rewrite it. Broken existing content cannot be salvaged.
      }
      trusted[this.deps.bundledDir] = 'TRUST_FOLDER';
      this.deps.fs.writeFile(path, `${JSON.stringify(trusted, null, 2)}\n`);
    } catch {
      // Cannot write: continue attempting the install.
    }
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin('gemini');
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.run(bin, ['extensions', 'uninstall', GEMINI_EXT_NAME]);
    if (un.code !== 0 && !absent(un.stderr)) {
      return { kind: 'failed', step: 'uninstall', stderr: un.stderr };
    }
    return { kind: 'ok', alreadyInstalled: false };
  }
}

function alreadyInstalled(s: string): boolean { return /already installed/i.test(s); }
