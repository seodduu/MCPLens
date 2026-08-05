import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateInferenceOutput } from '../../src/inference/validate.js';
import type { InferenceBatch } from '../../src/inference/types.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve('fixtures/inference', name), 'utf8'));

const batch: InferenceBatch = {
  batchId: 'batch-001',
  oversized: false,
  payloadTokens: 123,
  servers: [{
    serverName: 'github',
    tools: [{
      toolName: 'list_issues',
      description: 'List issues',
      inputSchemaJson: '{}',
      definitionTokens: 123,
      staticReferences: [],
      callChainSummary: [],
    }],
  }],
};

describe('validateInferenceOutput', () => {
  it('returns the normalized result when the input batch and the result servers/tools match exactly', () => {
    expect(validateInferenceOutput(batch, fixture('valid-independent.json')).results).toHaveLength(1);
  });

  it('rejects an extra tool that is absent from the input batch', () => {
    expect(() => validateInferenceOutput(batch, fixture('invalid-extra-tool.json'))).toThrow(/unexpected result tool/);
  });

  it('rejects a value outside the status enum', () => {
    expect(() => validateInferenceOutput(batch, {
      results: [{ ...(fixture('valid-independent.json') as { results: object[] }).results[0], status: 'Maybe' }],
    })).toThrow(/status is invalid/);
  });

  it('allows the English display fields only on Independent', () => {
    expect(() => validateInferenceOutput(batch, fixture('invalid-summary-language.json'))).toThrow(/English/);
  });

  it('forces the display fields to null in any state other than Independent', () => {
    const result = validateInferenceOutput(batch, {
      results: [{
        serverName: 'github',
        toolName: 'list_issues',
        status: 'Dependent',
        dependedOnBy: ['github/create_issue'],
        rationale: 'Repeated call-chain evidence links this tool to another tool.',
        displaySummary: 'The model tried to populate this field.',
        whatYouLose: 'The model tried to populate this field.',
        riskWithoutTool: 'The model tried to populate this field.',
      }],
    });

    expect(result.results[0]).toMatchObject({
      displaySummary: null,
      whatYouLose: null,
      riskWithoutTool: null,
    });
  });
});
