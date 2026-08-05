/**
 * 새 서버 자동 처리에 대한 동의.
 *
 * 첫 실행은 워크스루의 몫이지만, 그 뒤로 붙는 서버까지 사용자가 매번 손으로 재고
 * 분석하게 두면 이 도구를 쓸 이유가 없다. 그렇다고 말없이 자동으로 돌리면 사용자
 * 계정의 토큰이 승낙 없이 나간다. 그래서 온보딩에서 한 번 묻고, 그 답을 설정에
 * 적어 둔다. 이후로는 다시 묻지 않는다.
 */

export interface AutomationChoice {
  /** 새 서버를 자동으로 스캔한다 */
  autoScan: boolean;
  /** 스캔한 새 툴을 자동으로 분석한다 (제공자 CLI 토큰을 쓴다) */
  autoAnalyze: boolean;
}

export const AUTOMATION_PROMPT_TITLE = 'Keep MCP Lens up to date on its own?';

export const AUTOMATION_PROMPT_DETAIL = [
  'When you add a new MCP server later, Lens can measure it without asking again.',
  'Scan: Lens briefly starts the new server and reads its tool definitions. No LLM tokens are spent and no config file is modified.',
  'Analyze: Lens asks the provider you chose above whether each new tool can be turned off independently. This spends that account\'s tokens. Only tool definitions and aggregated usage counts are sent, and only for tools that have not been analyzed before.',
  'Servers that need a sign-in still ask you first.',
  'You can change this later with the mcpLens.autoScan and mcpLens.autoAnalyze settings, and withdrawing inference consent also stops automatic analysis.',
].join('\n\n');

export const AUTOMATION_ACCEPT_LABEL = 'Scan and analyze';
export const AUTOMATION_SCAN_ONLY_LABEL = 'Scan only';

/**
 * 대화상자 응답 → 설정값. 닫기(undefined)는 거절과 같게 다룬다.
 * 묻고 닫아 버린 것을 승낙으로 읽으면 그건 동의가 아니다.
 */
export function automationChoiceFrom(pick: string | undefined): AutomationChoice {
  if (pick === AUTOMATION_ACCEPT_LABEL) return { autoScan: true, autoAnalyze: true };
  if (pick === AUTOMATION_SCAN_ONLY_LABEL) return { autoScan: true, autoAnalyze: false };
  return { autoScan: false, autoAnalyze: false };
}

/** 설정에 적을 값. autoScan은 문자열 enum이라 여기서 변환한다. */
export function automationSettings(choice: AutomationChoice): {
  autoScan: 'always' | 'never'; autoAnalyze: boolean;
} {
  return { autoScan: choice.autoScan ? 'always' : 'never', autoAnalyze: choice.autoAnalyze };
}
