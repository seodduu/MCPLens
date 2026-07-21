import { spawn } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RunResult } from './hookInstall.js';

const BIN_CANDIDATES = (name: string): string[] => [
  join(homedir(), '.local', 'bin', name),
  `/opt/homebrew/bin/${name}`,
  `/usr/local/bin/${name}`,
];

// nvm has no `current` symlink — it installs under
// ~/.nvm/versions/node/<version>/bin/<name>. Scan every version directory.
// Must fail open: an unreadable/absent nvm root yields no candidates rather
// than throwing, consistent with the rest of this module.
// Exported so tests can point it at a temp directory instead of the
// developer's real ~/.nvm.
export function nvmCandidates(name: string, nvmRoot = join(homedir(), '.nvm')): string[] {
  const versionsDir = join(nvmRoot, 'versions', 'node');
  let versions: string[];
  try { versions = readdirSync(versionsDir); }
  catch { return []; }
  return versions.map((v) => join(versionsDir, v, 'bin', name));
}

// Locate a client binary without spawning a subprocess: probe known install
// locations, then scan PATH via stat only. Runs on the extension's startup
// detection path, so it must not block the host with a child process.
export function findBinary(name: string): string | null {
  for (const candidate of [...BIN_CANDIDATES(name), ...nvmCandidates(name)]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

// Claude-specific convenience wrapper, kept for existing callers.
export function findClaudeBinary(): string | null {
  return findBinary('claude');
}

// Async spawn (never spawnSync): the startup detection path awaits this, so it
// must yield to the event loop instead of blocking the extension host. Resolves
// (never rejects) to keep the caller fail-open.
export function runClaude(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args);
    } catch (error) {
      resolve({ stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ stdout, stderr: stderr || error.message, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

// spawn(bin, args) is already client-agnostic — alias it for generic callers.
export const runBin = runClaude;

export const nodeFs = {
  copyDir: (from: string, to: string) => cpSync(from, to, { recursive: true }),
  exists: (path: string) => existsSync(path),
  readDir: (path: string) => readdirSync(path),
};
