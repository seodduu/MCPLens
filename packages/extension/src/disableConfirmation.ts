import type { ToolDependencyResult } from '@mcp-lens/core';

export interface DisableConfirmation {
  /** Modal title line */
  message: string;
  /** Body: what is lost, whether it can be undone, when it takes effect */
  detail: string;
  confirmLabel: string;
}

const FALLBACK = 'Not available.';

/** The dialog wording is built as pure data. How it is displayed is up to the command side. */
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
