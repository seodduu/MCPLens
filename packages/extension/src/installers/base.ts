import type { ClientHookInstaller, InstallerDeps, InstallResult, InstallState, RunResult } from '../hookInstall.js';

/** Shared error message helpers for the hook installers. */
export function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * Decides whether a CLI stderr means "the target is already gone". The single decision point for
 * uninstall idempotence: removing an already-removed target is not a failure. It covers the measured
 *   claude: "...not found in installed plugins"
 *   gemini: 'Failed to uninstall "mcp-lens": Extension not found.'
 *   codex : not installed / no such
 * When a new wording turns up, add it here rather than in each installer.
 */
export function absent(s: string): boolean { return /not installed|not found|no such/i.test(s); }

/**
 * The never-throw mechanism shared by every `ClientHookInstaller` implementation.
 *
 * Collector installation and its failures never propagate into the user's MCP calls: installers
 * return an `InstallResult` union instead of throwing, and detection is fail-open
 * (`not-installed`/`client-missing`). That guarantee is enforced structurally here, not as a convention each subclass keeps.
 */
export abstract class BaseHookInstaller implements ClientHookInstaller {
  abstract readonly client: ClientHookInstaller['client'];

  constructor(protected deps: InstallerDeps) {}

  abstract detect(): Promise<InstallState>;
  abstract install(): Promise<InstallResult>;
  abstract uninstall(): Promise<InstallResult>;

  /** findBinary never propagates a throw; if it does, it is treated as client-missing. */
  protected bin(name: string): string | null {
    try { return this.deps.findBinary(name); }
    catch { return null; }
  }

  /** run never propagates a throw; it normalizes failures into a non-zero RunResult. */
  protected async run(bin: string, args: string[]): Promise<RunResult> {
    try { return await this.deps.run(bin, args); }
    catch (e) { return { stdout: '', stderr: msg(e), code: 1 }; }
  }
}
