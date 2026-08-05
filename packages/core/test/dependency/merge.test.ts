import { describe, it, expect } from 'vitest';
import { mergeDependencyResults, type DependencyEvidence } from '../../src/dependency/merge.js';
import type { ToolDefinitionBody, ToolDependencyResult } from '../../src/types.js';

const bodies: ToolDefinitionBody[] = [
  { serverName: 's', toolName: 'a', description: null, inputSchemaJson: '{}', definitionTokens: 1, definitionSetHash: 'h', scannedAt: 'now' },
  { serverName: 's', toolName: 'b', description: null, inputSchemaJson: '{}', definitionTokens: 1, definitionSetHash: 'h', scannedAt: 'now' },
  { serverName: 's', toolName: 'c', description: null, inputSchemaJson: '{}', definitionTokens: 1, definitionSetHash: 'h', scannedAt: 'now' },
];

const blocker: DependencyEvidence = {
  serverName: 's',
  toolName: 'a',
  dependedOnBy: ['b'],
  evidence: ['static:b'],
};

describe('mergeDependencyResults', () => {
  it('does not lower to LLM Independent when a static or call-chain blocker exists, leaving Review required', () => {
    const merged = mergeDependencyResults({
      bodies,
      staticRefs: [blocker],
      callChains: [],
      llmResults: [
        result('a', 'Independent'),
        result('b', 'Independent'),
        result('c', 'Independent', ['summary', 'lose', 'risk']),
      ],
    });

    expect(merged.find((r) => r.toolName === 'a')).toMatchObject({
      status: 'Review required',
      dependedOnBy: ['b'],
      displaySummary: null,
      whatYouLose: null,
      riskWithoutTool: null,
    });
    expect(merged.find((r) => r.toolName === 'c')).toMatchObject({
      status: 'Independent',
      displaySummary: 'summary',
      whatYouLose: 'lose',
      riskWithoutTool: 'risk',
    });
  });

  it('preserves LLM Dependent as it is and treats a missing result as Review required', () => {
    const merged = mergeDependencyResults({
      bodies,
      staticRefs: [],
      callChains: [],
      llmResults: [result('a', 'Dependent', ['drop', 'drop', 'drop'])],
    });

    expect(merged).toEqual([
      expect.objectContaining({ toolName: 'a', status: 'Dependent', displaySummary: null }),
      expect.objectContaining({ toolName: 'b', status: 'Review required', displaySummary: null }),
      expect.objectContaining({ toolName: 'c', status: 'Review required', displaySummary: null }),
    ]);
  });
});

function result(
  toolName: string,
  status: ToolDependencyResult['status'],
  explanation: [string, string, string] = ['s', 'l', 'r'],
): ToolDependencyResult {
  return {
    serverName: 's',
    toolName,
    status,
    dependedOnBy: [],
    rationale: `${toolName} ${status}`,
    displaySummary: explanation[0],
    whatYouLose: explanation[1],
    riskWithoutTool: explanation[2],
  };
}
