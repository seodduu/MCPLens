import { join } from 'node:path';
import type { HookClient, InstallerDeps, InstallState } from './hookInstall.js';

type Fs = InstallerDeps['fs'];

/**
 * Where each client runtime sits inside the bundle. These are paths relative to the bundledDir the
 * installer passes to the CLI, and they differ by one layer per client.
 */
const RUNTIME_SUBPATH: Record<HookClient, string[]> = {
  'claude-code': ['mcp-lens', 'runtime'],
  codex: ['plugins', 'mcp-lens', 'runtime'],
  'gemini-cli': ['runtime'],
};

const STAMP_FILE = 'runtime-stamp.json';

/** Record file holding the runtime fingerprint per client, as of installation time. */
export function stampRecordPath(home: string): string {
  return join(home, '.mcplens', 'installed-runtime.json');
}

function readJsonRecord(fs: Fs, path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFile(path));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {}; // missing or broken: treat as an empty record and rewrite it.
  }
}

/** Fingerprint of the runtime shipped with the extension. null when unreadable (undecidable). */
export function bundledStamp(fs: Fs, bundledDir: string, client: HookClient): string | null {
  const path = join(bundledDir, ...RUNTIME_SUBPATH[client], STAMP_FILE);
  const value = readJsonRecord(fs, path).stamp;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Fingerprint of the runtime actually installed for this client. null when there is no record. */
export function installedStamp(fs: Fs, home: string, client: HookClient): string | null {
  const value = readJsonRecord(fs, stampRecordPath(home))[client];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Called after a successful install. Failures are swallowed: bookkeeping must not break the install. */
export function recordInstalledStamp(
  fs: Fs, home: string, client: HookClient, stamp: string,
): void {
  try {
    const path = stampRecordPath(home);
    fs.writeFile(path, `${JSON.stringify({ ...readJsonRecord(fs, path), [client]: stamp }, null, 2)}\n`);
  } catch {
    // Failed to record: the next startup simply decides an update is needed again.
  }
}

/**
 * Is the installed hook runtime stale?
 *
 * The extension auto-updates from the marketplace, but an already-installed runtime copy stays as
 * it is. When the two versions exchange different formats, collection breaks silently (measured:
 * introducing the inbox file-name encoding lost every tool-call envelope). Users have no way to
 * notice, so the extension must detect it itself.
 *
 * With an unreadable bundle fingerprint there is no basis for comparison. Leaning toward
 * reinstalling there would reinstall on every startup, so nothing is done.
 */
export function needsRuntimeRefresh(
  install: InstallState,
  bundled: string | null,
  installed: string | null,
): boolean {
  // needs-approval also means the files are already installed, so a changed bundle makes it a target.
  // (Updating changes the hooks.json hash and codex asks for re-approval. That is the correct
  //  security behaviour, and the need for re-approval surfaces as the needs-approval state.)
  if ((install !== 'installed' && install !== 'needs-approval') || bundled === null) return false;
  return installed !== bundled;
}
