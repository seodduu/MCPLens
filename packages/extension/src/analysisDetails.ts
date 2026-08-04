import type { ToolDependencyResult } from '@mcp-lens/core';

export interface AnalysisDetailSection {
  label: string;
  value: string;
}

export interface AnalysisDetails {
  title: string;
  sections: AnalysisDetailSection[];
  notices: string[];
  canDisableGlobally: boolean;
}

/** Details are plain data so the command/UI boundary can choose its own renderer. */
export function buildAnalysisDetails(
  result: ToolDependencyResult,
  originalDefinition?: string,
): AnalysisDetails {
  const title = `${result.serverName}/${result.toolName}`;
  if (result.status !== 'Independent') {
    return {
      title,
      sections: [{ label: 'Rationale', value: result.rationale }],
      notices: [],
      canDisableGlobally: false,
    };
  }

  return {
    title,
    sections: [
      { label: 'What it does', value: result.displaySummary ?? result.rationale },
      { label: 'What you lose', value: result.whatYouLose ?? 'Not available.' },
      { label: 'Risk without this tool', value: result.riskWithoutTool ?? 'Not available.' },
      { label: 'Why Lens considers it independent', value: result.rationale },
      { label: 'View original definition', value: originalDefinition ?? 'Not available.' },
    ],
    notices: [
      'Applies to all projects',
      'Takes effect in new Claude Code / Codex sessions',
    ],
    canDisableGlobally: true,
  };
}
