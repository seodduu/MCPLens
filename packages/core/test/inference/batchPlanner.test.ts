import { describe, expect, it } from 'vitest';
import { planInferenceBatches } from '../../src/inference/batchPlanner.js';
import type { InferenceServerInput } from '../../src/inference/types.js';

function server(serverName: string, tokens: number): InferenceServerInput {
  return {
    serverName,
    tools: [{
      toolName: 'tool',
      description: null,
      inputSchemaJson: '{}',
      definitionTokens: tokens,
      staticReferences: [],
      callChainSummary: [],
    }],
  };
}

describe('planInferenceBatches', () => {
  it('입력 순서와 무관하게 serverName으로 정렬해 batch를 만든다', () => {
    const batches = planInferenceBatches([server('zeta', 10), server('alpha', 10), server('beta', 10)], 120_000);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.servers.map((item) => item.serverName)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('서버 단위 원자성을 지키며 한도 안에서 batch를 나눈다', () => {
    const batches = planInferenceBatches([server('b', 70_000), server('a', 60_000), server('c', 50_000)], 120_000);

    expect(batches.map((batch) => batch.servers.map((item) => item.serverName))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
    expect(batches.map((batch) => batch.payloadTokens)).toEqual([60_000, 120_000]);
  });

  it('Claude 120k와 Codex 200k 한도 차이를 호출자가 전달한 maxPayloadTokens로 반영한다', () => {
    expect(planInferenceBatches([server('a', 100_000), server('b', 90_000)], 120_000)).toHaveLength(2);
    expect(planInferenceBatches([server('a', 100_000), server('b', 90_000)], 200_000)).toHaveLength(1);
  });

  it('단일 oversized 서버는 독립 batch로 두고 oversized=true를 표시한다', () => {
    const batches = planInferenceBatches([server('small', 1_000), server('huge', 200_001)], 200_000);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ oversized: true, payloadTokens: 200_001 });
    expect(batches[0]!.servers.map((item) => item.serverName)).toEqual(['huge']);
  });
});
