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

/**
 * computeCollection() 한 사이클이 끝나고 결과를 반영할 때 실제로 실행하는 네 가지 부수효과.
 * extension.ts는 vscode API에 의존하는 콜백을 여기 채워 넣고, 이 모듈은 순서와 가드만 책임진다.
 * (vscode를 import하지 않으므로 유닛테스트에서 이 순서·가드 자체를 직접 검증할 수 있다.)
 */
export interface CollectionResultEffects<TInputs> {
  applyInputs: (inputs: TInputs) => void;
  setClients: (inputs: TInputs) => void;
  refreshSetupKeys: (inputs: TInputs) => Promise<void> | void;
  refreshSetupRows: () => void;
}

/**
 * computeCollection()의 세대 가드 적용 지점을 뽑아낸 순수 함수.
 * withGenerationGuard와 동일하게, gen이 시작 시점의 currentGeneration()과 같을 때만
 * 네 부수효과를 (applyInputs → setClients → refreshSetupKeys → refreshSetupRows) 순서로 전부 실행한다.
 * 어긋나면 하나도 실행하지 않는다. 일단 시작하면(gen이 통과하면) 중간에 세대가 바뀌어도
 * 이미 시작한 실행은 끝까지 간다 — withGenerationGuard가 실행 도중 재검사를 하지 않기 때문이다.
 */
export async function applyCollectionResult<TInputs>(
  gen: number,
  currentGeneration: () => number,
  inputs: TInputs,
  effects: CollectionResultEffects<TInputs>,
): Promise<void> {
  await withGenerationGuard(gen, currentGeneration, async () => {
    effects.applyInputs(inputs);
    effects.setClients(inputs);
    await effects.refreshSetupKeys(inputs);
    effects.refreshSetupRows();
  });
}
