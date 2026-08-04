import type { HookClient, InstallState } from './hookInstall.js';

// Pure module: no vscode import here so it can be unit-tested directly
// (extension.ts imports vscode at module scope, which would break a test
// importing pendingHookClients from there).

/**
 * 넛지 대상 선정: 감지됐고(detected) 훅 미설치(not-installed)이며
 * dismiss 안 된 클라이언트 목록.
 */
export function pendingHookClients(
  detected: ReadonlySet<HookClient>,
  states: ReadonlyMap<HookClient, InstallState>,
  dismissed: ReadonlySet<HookClient>,
): HookClient[] {
  return [...detected].filter((c) =>
    states.get(c) === 'not-installed' && !dismissed.has(c));
}

/**
 * 훅은 켰지만 codex 승인이 남은 클라이언트. 설치 안내와 문구가 달라야 한다 —
 * 여기서 "설치"를 다시 권하면 사용자가 눌러도 아무 변화가 없어 같은 거짓 성공이 반복된다.
 */
export function approvalPendingClients(
  detected: ReadonlySet<HookClient>,
  states: ReadonlyMap<HookClient, InstallState>,
  dismissed: ReadonlySet<HookClient>,
): HookClient[] {
  return [...detected].filter((c) =>
    states.get(c) === 'needs-approval' && !dismissed.has(c));
}
