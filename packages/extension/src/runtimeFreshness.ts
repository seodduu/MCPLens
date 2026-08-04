import { join } from 'node:path';
import type { HookClient, InstallerDeps, InstallState } from './hookInstall.js';

type Fs = InstallerDeps['fs'];

/**
 * 번들 안에서 각 클라이언트 런타임이 놓이는 위치. 설치기가 CLI에 넘기는
 * bundledDir 기준의 상대 경로다 — 클라이언트마다 한 겹씩 다르다.
 */
const RUNTIME_SUBPATH: Record<HookClient, string[]> = {
  'claude-code': ['mcp-lens', 'runtime'],
  codex: ['plugins', 'mcp-lens', 'runtime'],
  'gemini-cli': ['runtime'],
};

const STAMP_FILE = 'runtime-stamp.json';

/** 설치 시점의 런타임 지문을 클라이언트별로 남기는 기록 파일. */
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
    return {}; // 없거나 깨졌다 — 빈 기록으로 취급하고 새로 쓴다.
  }
}

/** 확장에 동봉된 런타임의 지문. 읽을 수 없으면 null(판정 불가). */
export function bundledStamp(fs: Fs, bundledDir: string, client: HookClient): string | null {
  const path = join(bundledDir, ...RUNTIME_SUBPATH[client], STAMP_FILE);
  const value = readJsonRecord(fs, path).stamp;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 이 클라이언트에 실제로 설치해 둔 런타임의 지문. 기록이 없으면 null. */
export function installedStamp(fs: Fs, home: string, client: HookClient): string | null {
  const value = readJsonRecord(fs, stampRecordPath(home))[client];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 설치 성공 후 호출한다. 실패는 삼킨다 — 기록 때문에 설치가 깨지면 안 된다. */
export function recordInstalledStamp(
  fs: Fs, home: string, client: HookClient, stamp: string,
): void {
  try {
    const path = stampRecordPath(home);
    fs.writeFile(path, `${JSON.stringify({ ...readJsonRecord(fs, path), [client]: stamp }, null, 2)}\n`);
  } catch {
    // 기록 실패 — 다음 기동에서 갱신 필요로 재판정될 뿐이다.
  }
}

/**
 * 설치된 훅 런타임이 낡았는가.
 *
 * 확장은 마켓플레이스에서 자동 업데이트되지만 이미 설치된 런타임 사본은 그대로
 * 남는다. 두 버전이 다른 형식을 주고받으면 수집이 조용히 망가진다(실측: inbox
 * 파일명 인코딩 도입 시 툴 호출 봉투 전량 유실). 사용자가 알아챌 방법이 없으므로
 * 확장이 스스로 감지해야 한다.
 *
 * 번들 지문을 못 읽으면 비교 근거가 없다 — 이때 재설치로 기울면 매 기동마다
 * 재설치를 반복하게 되므로 아무것도 하지 않는다.
 */
export function needsRuntimeRefresh(
  install: InstallState,
  bundled: string | null,
  installed: string | null,
): boolean {
  // needs-approval도 파일은 이미 설치돼 있다 — 번들이 바뀌면 갱신 대상이다.
  // (갱신하면 hooks.json 해시가 바뀌어 codex가 재승인을 요구한다. 그것이 올바른
  //  보안 동작이며, 재승인이 필요해진 사실은 needs-approval 상태로 표면화된다.)
  if ((install !== 'installed' && install !== 'needs-approval') || bundled === null) return false;
  return installed !== bundled;
}
