import { spawn } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RunResult } from './hookInstall.js';

const CANDIDATES = (): string[] => [
  join(homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

// Locate the claude binary without spawning a subprocess: probe known install
// locations, then scan PATH via stat only. Runs on the extension's startup
// detection path, so it must not block the host with a child process.
export function findClaudeBinary(): string | null {
  for (const candidate of CANDIDATES()) if (existsSync(candidate)) return candidate;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'claude'))) return join(dir, 'claude');
  }
  return null;
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

export const nodeFs = {
  copyDir: (from: string, to: string) => cpSync(from, to, { recursive: true }),
  exists: (path: string) => existsSync(path),
  readDir: (path: string) => readdirSync(path),
};
