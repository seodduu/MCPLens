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

function tool(toolName: string) {
  return {
    toolName,
    description: null,
    inputSchemaJson: '{}',
    definitionTokens: 10,
    staticReferences: [],
    callChainSummary: [],
  };
}

const chromeBatch: InferenceBatch = {
  batchId: 'batch-002',
  oversized: false,
  payloadTokens: 200,
  servers: [
    { serverName: 'chrome', tools: [tool('navigate'), tool('read_page')], stateConsumers: [] },
    { serverName: 'github', tools: [tool('list_issues')], stateConsumers: [] },
  ],
};

function reviewResult(serverName: string, toolName: string) {
  return {
    serverName,
    toolName,
    status: 'Review required',
    dependedOnBy: [],
    rationale: 'Call-chain evidence exists but does not confirm inbound dependency.',
    displaySummary: null,
    whatYouLose: null,
    riskWithoutTool: null,
  };
}

const chromeResults = [
  reviewResult('chrome', 'navigate'),
  reviewResult('chrome', 'read_page'),
  reviewResult('github', 'list_issues'),
];

describe('validateInferenceOutput predictedPrerequisites', () => {
  it('accepts a well-formed prerequisite entry', () => {
    const result = validateInferenceOutput(chromeBatch, {
      results: chromeResults,
      predictedPrerequisites: [{
        toolName: 'read_page',
        requires: ['navigate'],
        basis: 'read_page reads the page navigate opened.',
      }],
    });

    expect(result.predictedPrerequisites).toEqual([{
      toolName: 'read_page',
      requires: ['navigate'],
      basis: 'read_page reads the page navigate opened.',
    }]);
  });

  it('treats a missing prerequisites field as empty', () => {
    const result = validateInferenceOutput(chromeBatch, { results: chromeResults });

    expect(result.results).toHaveLength(3);
    expect(result.predictedPrerequisites).toEqual([]);
  });

  it('drops an entry naming a tool outside the batch', () => {
    const result = validateInferenceOutput(chromeBatch, {
      results: chromeResults,
      predictedPrerequisites: [{
        toolName: 'close_tab',
        requires: ['navigate'],
        basis: 'The model named a tool the batch never provided.',
      }],
    });

    expect(result.predictedPrerequisites).toEqual([]);
    expect(result.results).toHaveLength(3);
  });

  it('drops an unknown name from requires but keeps the entry', () => {
    const result = validateInferenceOutput(chromeBatch, {
      results: chromeResults,
      predictedPrerequisites: [{
        toolName: 'read_page',
        requires: ['navigate', 'open_browser'],
        basis: 'Only one of the required names exists in the batch.',
      }],
    });

    expect(result.predictedPrerequisites).toHaveLength(1);
    expect(result.predictedPrerequisites[0]?.requires).toEqual(['navigate']);
  });

  it('drops an entry whose requires becomes empty', () => {
    const result = validateInferenceOutput(chromeBatch, {
      results: chromeResults,
      predictedPrerequisites: [{
        toolName: 'read_page',
        requires: ['open_browser'],
        basis: 'Every required name is unknown, so nothing is left to keep.',
      }],
    });

    expect(result.predictedPrerequisites).toEqual([]);
  });

  it('drops a cross-server requires name', () => {
    const result = validateInferenceOutput(chromeBatch, {
      results: chromeResults,
      predictedPrerequisites: [{
        toolName: 'list_issues',
        requires: ['navigate'],
        basis: 'A github tool cannot depend on a chrome tool.',
      }],
    });

    expect(result.predictedPrerequisites).toEqual([]);
  });

  it('drops a self-reference', () => {
    const result = validateInferenceOutput(chromeBatch, {
      results: chromeResults,
      predictedPrerequisites: [{
        toolName: 'read_page',
        requires: ['read_page'],
        basis: 'A tool cannot be its own prerequisite.',
      }],
    });

    expect(result.predictedPrerequisites).toEqual([]);
  });

  it('still fails the batch when results omit a tool', () => {
    expect(() => validateInferenceOutput(chromeBatch, {
      results: [reviewResult('chrome', 'navigate'), reviewResult('chrome', 'read_page')],
      predictedPrerequisites: [],
    })).toThrow(/result tool set mismatch/);
  });
});

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
