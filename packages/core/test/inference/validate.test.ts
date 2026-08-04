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
  it('입력 batch와 결과 서버/툴이 완전히 일치하면 정규화 결과를 반환한다', () => {
    expect(validateInferenceOutput(batch, fixture('valid-independent.json')).results).toHaveLength(1);
  });

  it('입력 batch에 없는 extra tool을 거부한다', () => {
    expect(() => validateInferenceOutput(batch, fixture('invalid-extra-tool.json'))).toThrow(/unexpected result tool/);
  });

  it('status enum 밖의 값을 거부한다', () => {
    expect(() => validateInferenceOutput(batch, {
      results: [{ ...(fixture('valid-independent.json') as { results: object[] }).results[0], status: 'Maybe' }],
    })).toThrow(/status is invalid/);
  });

  it('Independent에서만 English display fields를 허용한다', () => {
    expect(() => validateInferenceOutput(batch, fixture('invalid-summary-language.json'))).toThrow(/English/);
  });

  it('Independent가 아닌 상태에서는 display fields를 null로 강제한다', () => {
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
