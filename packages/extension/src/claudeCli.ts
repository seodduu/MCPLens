import { spawn, type SpawnOptions } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunResult } from './hookInstall.js';

/**
 * Platform and environment are injectable. They default to the running process, but the Windows
 * path rules must be reproducible in tests on a developer's macOS/Linux machine.
 */
export interface ProbeEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const WIN_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Child process ceiling. If the CLI raises an interactive prompt it lives forever waiting on stdin,
 * close never arrives, and the UI waits indefinitely (measured with gemini-cli 0.51.0).
 * Closing stdio.stdin with 'ignore' was not enough: the prompt still stalls.
 * The limit is generous because install commands sometimes hit the network (git clone and friends).
 */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * File names to look up. On win32 the PATHEXT extensions are checked **first**:
 * an npm global install drops both `codex.cmd` and an extensionless sh script `codex` into the same
 * directory, and the latter cannot run on Windows. The extensionless name is the last fallback.
 */
function execNames(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [name];
  const exts = (env.PATHEXT ?? WIN_DEFAULT_PATHEXT)
    .split(';').map((e) => e.trim()).filter((e) => e !== '');
  return [...exts.map((e) => name + e.toLowerCase()), name];
}

/** Candidate directories where each client CLI actually installs (some may not be on PATH). */
function binDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    return [
      join(home, '.local', 'bin'),                                  // Claude Code native install
      ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),           // npm global prefix
      ...(env.LOCALAPPDATA ? [
        join(env.LOCALAPPDATA, 'Volta', 'bin'),
        join(env.LOCALAPPDATA, 'Programs', 'npm'),
      ] : []),
    ];
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

/**
 * Candidate nvm version directories. The layout differs per platform:
 *   POSIX      : <root>/versions/node/<version>/bin/<name>   (no `current` symlink)
 *   nvm-windows: <root>/<version>/<name>                     (no bin directory)
 * An unreadable or missing root yields an empty array rather than a throw: this whole module is fail-open.
 * Exported so tests can point at a temp directory instead of the developer's real ~/.nvm.
 */
export function nvmCandidates(
  name: string,
  nvmRoot = join(homedir(), '.nvm'),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const versionsDir = platform === 'win32' ? nvmRoot : join(nvmRoot, 'versions', 'node');
  let versions: string[];
  try { versions = readdirSync(versionsDir); }
  catch { return []; }
  return versions.map((v) => (platform === 'win32'
    ? join(versionsDir, v, name)
    : join(versionsDir, v, 'bin', name)));
}

function nvmRootFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform !== 'win32') return join(home, '.nvm');
  return env.NVM_HOME ?? env.NVM_SYMLINK ?? join(env.APPDATA ?? home, 'nvm');
}

/**
 * Finds the client binary without spawning a subprocess: it checks the known install locations
 * first, then walks PATH with stat alone. It runs on the extension startup detection path, so it
 * must never block the host with a child process.
 */
export function findBinary(name: string, probe: ProbeEnv = {}): string | null {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const home = probe.home ?? homedir();
  const names = execNames(name, platform, env);
  const pathDelimiter = platform === 'win32' ? ';' : ':';

  // The search order preserves the existing (POSIX) behaviour: known install locations, nvm, PATH.
  // Pushing nvm after PATH could change which binary an nvm user picks up.
  const nvmRoot = nvmRootFor(platform, env, home);
  const candidates = [
    ...binDirs(platform, env, home).flatMap((dir) => names.map((n) => join(dir, n))),
    ...names.flatMap((n) => nvmCandidates(n, nvmRoot, platform)),
    ...(env.PATH ?? '').split(pathDelimiter).filter((d) => d !== '')
      .flatMap((dir) => names.map((n) => join(dir, n))),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Claude-specific convenience wrapper, kept for existing callers. */
export function findClaudeBinary(): string | null {
  return findBinary('claude');
}

/**
 * Computes the spawn arguments. On Windows a `.cmd`/`.bat` is a cmd.exe script rather than an
 * executable, so spawning it directly fails with EINVAL on Node 18.20.2+ (the CVE-2024-27980 fix).
 * Going through the shell is the only option, and shell:true concatenates arguments verbatim, so a
 * path containing spaces (`C:\Users\First Last\...`) must be quoted here.
 * `.exe` files and POSIX binaries are spawned directly without quoting, which is always safer.
 */
export function spawnSpec(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; options: SpawnOptions } {
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  if (!needsShell) return { command: bin, args, options: {} };
  return {
    command: quoteWin(bin),
    args: args.map(quoteWin),
    options: { shell: true },
  };
}

/** cmd.exe quoting: wrap in double quotes when spaces or special characters appear, escaping inner quotes. */
function quoteWin(s: string): string {
  if (s !== '' && !/[\s"^&|<>()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Asynchronous spawn (never spawnSync): the startup detection path awaits this, so it must yield to
 * the event loop instead of blocking the extension host. It always resolves and never rejects, which
 * keeps callers fail-open.
 */
export function runClaude(
  bin: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const spec = spawnSpec(bin, args);
    let child;
    try {
      child = spawn(spec.command, spec.args, { ...spec.options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        stdout,
        stderr: `${stderr}\n[mcp-lens] timed out (${timeoutMs}ms); the CLI may be waiting on an interactive prompt.`,
        code: 1,
      });
    }, timeoutMs);
    // The extension host must never be kept from exiting by this timer.
    timer.unref?.();

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ stdout, stderr: stderr || error.message, code: 1 }));
    child.on('close', (code) => finish({ stdout, stderr, code: code ?? 1 }));
  });
}

// spawn(bin, args) is already client-agnostic; this is an alias for general callers.
export const runBin = runClaude;

export const nodeFs = {
  copyDir: (from: string, to: string) => cpSync(from, to, { recursive: true }),
  exists: (path: string) => existsSync(path),
  readDir: (path: string) => readdirSync(path),
  readFile: (path: string) => readFileSync(path, 'utf8'),
  writeFile: (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
};
