import { spawn, type SpawnOptions } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from './hookInstall.js';

/**
 * 플랫폼·환경을 주입 가능하게 둔다. 기본값은 실행 중인 프로세스지만,
 * Windows 경로 규칙은 개발자의 macOS/Linux 기기에서 테스트로 재현해야 한다.
 */
export interface ProbeEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const WIN_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * 조회할 파일명 목록. win32에서는 PATHEXT 확장자를 **먼저** 본다 —
 * npm 전역 설치는 `codex.cmd`와 확장자 없는 sh 스크립트 `codex`를 한 디렉터리에
 * 같이 깔고, 후자는 Windows에서 실행할 수 없다. 확장자 없는 이름은 최후 폴백.
 */
function execNames(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [name];
  const exts = (env.PATHEXT ?? WIN_DEFAULT_PATHEXT)
    .split(';').map((e) => e.trim()).filter((e) => e !== '');
  return [...exts.map((e) => name + e.toLowerCase()), name];
}

/** 각 클라이언트 CLI가 실제로 설치되는 디렉터리 후보 (PATH에 없을 수 있는 것들). */
function binDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    return [
      join(home, '.local', 'bin'),                                  // Claude Code 네이티브 설치
      ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),           // npm 전역 prefix
      ...(env.LOCALAPPDATA ? [
        join(env.LOCALAPPDATA, 'Volta', 'bin'),
        join(env.LOCALAPPDATA, 'Programs', 'npm'),
      ] : []),
    ];
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

/**
 * nvm 버전 디렉터리 후보. 레이아웃이 플랫폼마다 다르다:
 *   POSIX      : <root>/versions/node/<version>/bin/<name>   (`current` 심볼릭 링크 없음)
 *   nvm-windows: <root>/<version>/<name>                     (bin 디렉터리 없음)
 * 읽을 수 없는/없는 루트는 throw가 아니라 빈 배열 — 이 모듈 전체가 fail-open이다.
 * 테스트가 개발자의 실제 ~/.nvm 대신 임시 디렉터리를 가리킬 수 있게 export한다.
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
 * 서브프로세스를 띄우지 않고 클라이언트 바이너리를 찾는다: 알려진 설치 위치를
 * 먼저 보고, 그다음 PATH를 stat으로만 훑는다. 확장 기동의 감지 경로에서 돌기
 * 때문에 자식 프로세스로 호스트를 블로킹하면 안 된다.
 */
export function findBinary(name: string, probe: ProbeEnv = {}): string | null {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const home = probe.home ?? homedir();
  const names = execNames(name, platform, env);
  const pathDelimiter = platform === 'win32' ? ';' : ':';

  // 탐색 순서는 기존(POSIX) 동작을 그대로 유지한다: 알려진 설치 위치 → nvm → PATH.
  // nvm을 PATH보다 뒤로 미루면 nvm 사용자가 집던 바이너리가 바뀔 수 있다.
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

/** Claude 전용 편의 래퍼 — 기존 호출자를 위해 유지. */
export function findClaudeBinary(): string | null {
  return findBinary('claude');
}

/**
 * spawn 인자 계산. Windows의 `.cmd`/`.bat`은 실행 파일이 아니라 cmd.exe 스크립트라
 * Node 18.20.2+ 에서 직접 spawn하면 EINVAL로 실패한다(CVE-2024-27980 대응).
 * shell 경유가 유일한 방법이고, shell:true는 인자를 그대로 이어붙이므로
 * 공백이 든 경로(`C:\Users\First Last\...`)는 여기서 인용해야 한다.
 * `.exe`와 POSIX 바이너리는 인용 없이 직접 spawn — 그쪽이 항상 더 안전하다.
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

/** cmd.exe 인용: 공백/특수문자가 있으면 큰따옴표로 감싸고 내부 따옴표를 이스케이프. */
function quoteWin(s: string): string {
  if (s !== '' && !/[\s"^&|<>()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * 비동기 spawn(절대 spawnSync 아님): 기동 감지 경로가 이걸 await하므로 확장
 * 호스트를 블로킹하지 않고 이벤트 루프에 양보해야 한다. 호출자를 fail-open으로
 * 유지하려고 reject하지 않고 항상 resolve한다.
 */
export function runClaude(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const spec = spawnSpec(bin, args);
    let child;
    try {
      child = spawn(spec.command, spec.args, spec.options);
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

// spawn(bin, args)는 이미 클라이언트 무관 — 범용 호출자를 위한 별칭.
export const runBin = runClaude;

export const nodeFs = {
  copyDir: (from: string, to: string) => cpSync(from, to, { recursive: true }),
  exists: (path: string) => existsSync(path),
  readDir: (path: string) => readdirSync(path),
};
