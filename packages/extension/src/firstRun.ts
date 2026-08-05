// Never imports vscode: pure logic only, so it can be verified with unit tests.

export const WALKTHROUGH_OPENED_KEY = 'mcpLens.walkthroughOpened';
export const WALKTHROUGH_CATEGORY_ID = 'seodduu.mcp-context-lens#mcpLens.setup';

export interface FirstRunState {
  get(key: string): boolean | undefined;
  update(key: string, value: boolean): Thenable<void>;
}

/** True only on the first activation. The flag is written first, so an open failure does not retry every time and pop the tab repeatedly. */
export async function claimFirstRun(state: FirstRunState): Promise<boolean> {
  if (state.get(WALKTHROUGH_OPENED_KEY) === true) return false;
  await state.update(WALKTHROUGH_OPENED_KEY, true);
  return true;
}
