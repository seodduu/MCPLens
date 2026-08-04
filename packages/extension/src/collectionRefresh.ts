/**
 * computeCollection()의 stale-run 가드.
 *
 * computeCollection()은 클라이언트마다 CLI 서브프로세스(detect())를 기다리는 동안
 * 새 refresh가 겹쳐 들어올 수 있다. 예전에는 lastCollectionInputs/hookStatusProvider 갱신만
 * 세대 가드 안에 있고 refreshSetupKeys/refreshSetupRows는 가드 밖에서 무조건 실행됐다.
 * 그 결과 늦게 끝난 낡은 실행이 최신 실행이 이미 반영한 컨텍스트 키를 낡은 값으로 덮어쓰고
 * welcome.markStepIncomplete를 잘못 쏴서, 사용자가 방금 딴 체크마크를 지울 수 있었다(메멘토에도 남음).
 *
 * apply 콜백 하나로 "이번 실행 결과를 반영하는 모든 부수효과"를 묶어, 세대가 어긋나면
 * 전부 건너뛰거나 전부 반영하게 한다. 일부만 반영되는 경합을 원천적으로 막는 방식이다.
 */
export async function withGenerationGuard(
  gen: number,
  currentGeneration: () => number,
  apply: () => Promise<void> | void,
): Promise<void> {
  if (gen === currentGeneration()) {
    await apply();
  }
}
