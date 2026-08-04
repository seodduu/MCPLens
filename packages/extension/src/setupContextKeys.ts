import type { InstallState } from './hookInstall.js';

export interface SetupKeys {
  scanReady: boolean;
  hooksReady: boolean;
  analysisReady: boolean;
  globalActionsReady: boolean;
}

export interface SetupKeyInput {
  /** 감지 결과. client-missing은 판정에서 제외한다 */
  installs: readonly { install: InstallState | string }[];
  definitionCount: number;
  consentAccepted: boolean;
  analyzedServerCount: number;
  /** mcplens.dependencyAnalysis.rollout 설정값. 미설정이면 undefined */
  rollout: string | undefined;
}

const STEP_PREFIX = 'seodduu.mcp-context-lens#mcpLens.setup#';

export const SETUP_STEP_IDS: Record<keyof SetupKeys, string> = {
  scanReady: `${STEP_PREFIX}scan`,
  hooksReady: `${STEP_PREFIX}hooks`,
  analysisReady: `${STEP_PREFIX}analyze`,
  globalActionsReady: `${STEP_PREFIX}actions`,
};

export function evaluateSetupKeys(input: SetupKeyInput): SetupKeys {
  // 설치되지 않은 클라이언트는 사용자가 할 일이 없다 — 판정 모수에서 뺀다.
  const present = input.installs.filter((row) => row.install !== 'client-missing');
  return {
    scanReady: input.definitionCount > 0,
    // needs-approval을 참으로 세면 수집 0건인데 체크가 켜지는 거짓 성공이 난다.
    hooksReady: present.length > 0 && present.every((row) => row.install === 'installed'),
    analysisReady: input.consentAccepted && input.analyzedServerCount > 0,
    // 값이 없으면 VS Code 설정 기본값(shadow)과 같다. shadow는 잠금 상태이므로 거짓이어야 한다.
    globalActionsReady: input.rollout !== undefined && input.rollout !== 'shadow',
  };
}

/**
 * 참에서 거짓으로 바뀐 키의 스텝 id.
 * 거짓인 동안 매번 해제하면 사용자가 손으로 체크한 것까지 지운다.
 */
export function stepsToUncheck(prev: SetupKeys | undefined, next: SetupKeys): string[] {
  if (prev === undefined) return [];
  return (Object.keys(SETUP_STEP_IDS) as (keyof SetupKeys)[])
    .filter((key) => prev[key] && !next[key])
    .map((key) => SETUP_STEP_IDS[key]);
}
