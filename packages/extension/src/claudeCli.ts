import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from './hookInstall.js';

const CANDIDATES = (): string[] => [
  join(homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

export function findClaudeBinary(): string | null {
  for (const candidate of CANDIDATES()) if (existsSync(candidate)) return candidate;
  const onPath = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return onPath.status === 0 ? 'claude' : null;
}

export function runClaude(bin: string, args: string[]): Promise<RunResult> {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 });
}

export const nodeFs = {
  copyDir: (from: string, to: string) => cpSync(from, to, { recursive: true }),
  exists: (path: string) => existsSync(path),
  readDir: (path: string) => readdirSync(path),
};
