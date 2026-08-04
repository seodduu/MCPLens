// vscode를 import하지 않는다 — 순수 로직만 두어 유닛테스트로 검증한다.

export const WALKTHROUGH_OPENED_KEY = 'mcpLens.walkthroughOpened';
export const WALKTHROUGH_CATEGORY_ID = 'seodduu.mcp-context-lens#mcpLens.setup';

export interface FirstRunState {
  get(key: string): boolean | undefined;
  update(key: string, value: boolean): Thenable<void>;
}

/** 처음 활성화 1회만 참. 플래그를 먼저 기록한다 — open 실패로 매번 재시도해 탭이 반복해 뜨는 것을 막는다. */
export async function claimFirstRun(state: FirstRunState): Promise<boolean> {
  if (state.get(WALKTHROUGH_OPENED_KEY) === true) return false;
  await state.update(WALKTHROUGH_OPENED_KEY, true);
  return true;
}
