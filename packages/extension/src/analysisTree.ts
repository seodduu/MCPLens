import type { ToolDependencyResult } from '@mcp-lens/core';

export type AnalysisDisplayStatus = ToolDependencyResult['status']
  | 'Not analyzed' | 'Analysis failed' | 'Identity conflict';

export interface AnalysisRow {
  serverName: string;
  toolName: string;
  status: AnalysisDisplayStatus;
  rationale?: string;
  summary?: string;
  action?: 'Disable globally…';
  canDisableGlobally: boolean;
}

export interface AnalysisStateRow {
  serverName: string;
  toolName: string;
  state: Exclude<AnalysisDisplayStatus, ToolDependencyResult['status']>;
  rationale?: string;
}

export function globalEnforcementNotice(options: {
  claudeMode?: 'bypassPermissions' | 'standard';
  policyWriteRestricted?: boolean;
}): string | undefined {
  if (options.policyWriteRestricted) return 'Policy restricted';
  if (options.claudeMode === 'bypassPermissions') {
    return 'Global enforcement is not guaranteed in bypassPermissions mode.';
  }
  return undefined;
}

/** Produces tree-ready analysis data without depending on VS Code objects. */
export function buildAnalysisRows(
  results: readonly ToolDependencyResult[],
  states: readonly AnalysisStateRow[] = [],
): AnalysisRow[] {
  return [
    ...results.map((result): AnalysisRow => {
      const independent = result.status === 'Independent';
      return {
        serverName: result.serverName,
        toolName: result.toolName,
        status: result.status,
        rationale: result.rationale,
        ...(independent && result.displaySummary ? { summary: result.displaySummary } : {}),
        ...(independent ? { action: 'Disable globally…' as const } : {}),
        canDisableGlobally: independent,
      };
    }),
    ...states.map((state): AnalysisRow => ({
      serverName: state.serverName,
      toolName: state.toolName,
      status: state.state,
      rationale: state.rationale,
      canDisableGlobally: false,
    })),
  ];
}
