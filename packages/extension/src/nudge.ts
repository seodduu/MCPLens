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
