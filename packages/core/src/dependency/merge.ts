import type { ToolDefinitionBody, ToolDependencyResult } from '../types.js';

export interface DependencyEvidence {
  serverName: string;
  toolName: string;
  dependedOnBy: string[];
  evidence: string[];
}

export interface MergeDependencyInput {
  bodies: readonly ToolDefinitionBody[];
  staticRefs: readonly DependencyEvidence[];
  callChains: readonly DependencyEvidence[];
  llmResults: readonly ToolDependencyResult[];
}

export function mergeDependencyResults(input: MergeDependencyInput): ToolDependencyResult[] {
  const blockers = evidenceByTool([...input.staticRefs, ...input.callChains]);
  const llmByTool = new Map(input.llmResults.map((result) => [keyOf(result), result]));

  return [...input.bodies]
    .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.toolName.localeCompare(b.toolName))
    .map((body) => {
      const key = keyOf(body);
      const llm = llmByTool.get(key);
      const blocker = blockers.get(key);
      const dependedOnBy = blocker?.dependedOnBy ?? llm?.dependedOnBy ?? [];
      const rationale = [
        llm?.rationale ?? 'LLM result missing.',
        ...(blocker?.evidence ?? []),
      ].join(' ');

      if (llm?.status === 'Dependent') {
        return scrubExplanations({
          ...llm,
          dependedOnBy,
          rationale,
        });
      }

      if (blocker !== undefined) {
        return scrubExplanations({
          serverName: body.serverName,
          toolName: body.toolName,
          status: 'Review required',
          dependedOnBy,
          rationale,
          displaySummary: null,
          whatYouLose: null,
          riskWithoutTool: null,
        });
      }

      if (llm === undefined) {
        return scrubExplanations({
          serverName: body.serverName,
          toolName: body.toolName,
          status: 'Review required',
          dependedOnBy: [],
          rationale,
          displaySummary: null,
          whatYouLose: null,
          riskWithoutTool: null,
        });
      }

      return scrubExplanations(llm);
    });
}

function evidenceByTool(rows: DependencyEvidence[]): Map<string, DependencyEvidence> {
  const merged = new Map<string, DependencyEvidence>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = merged.get(key) ?? { serverName: row.serverName, toolName: row.toolName, dependedOnBy: [], evidence: [] };
    current.dependedOnBy.push(...row.dependedOnBy.filter((tool) => !current.dependedOnBy.includes(tool)));
    current.evidence.push(...row.evidence.filter((evidence) => !current.evidence.includes(evidence)));
    current.dependedOnBy.sort();
    current.evidence.sort();
    merged.set(key, current);
  }
  return merged;
}

function scrubExplanations(result: ToolDependencyResult): ToolDependencyResult {
  if (result.status === 'Independent') return result;
  return {
    ...result,
    displaySummary: null,
    whatYouLose: null,
    riskWithoutTool: null,
  };
}

function keyOf(value: { serverName: string; toolName: string }): string {
  return `${value.serverName}\0${value.toolName}`;
}
