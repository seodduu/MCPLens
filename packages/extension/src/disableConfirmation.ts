import type { ToolDependencyResult } from '@mcp-lens/core';

export interface DisableConfirmation {
  /** 모달 제목 줄 */
  message: string;
  /** 본문 — 무엇을 잃는지, 되돌릴 수 있는지, 언제 적용되는지 */
  detail: string;
  confirmLabel: string;
}

const FALLBACK = 'Not available.';

/** 대화상자 문구는 순수 데이터로 만든다. 표시 방법은 커맨드 쪽이 정한다. */
export function buildDisableConfirmation(result: ToolDependencyResult): DisableConfirmation {
  const lines = [
    `What you lose: ${result.whatYouLose ?? FALLBACK}`,
    `Risk without this tool: ${result.riskWithoutTool ?? FALLBACK}`,
    'Applies to all projects and takes effect in new sessions.',
    'You can restore it any time from the same row.',
  ];
  return {
    message: `Disable ${result.serverName}/${result.toolName} globally?`,
    detail: lines.join('\n\n'),
    confirmLabel: 'Disable globally',
  };
}
