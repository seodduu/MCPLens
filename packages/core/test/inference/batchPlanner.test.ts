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
  it('builds batches sorted by serverName regardless of input order', () => {
    const batches = planInferenceBatches([server('zeta', 10), server('alpha', 10), server('beta', 10)], 120_000);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.servers.map((item) => item.serverName)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('splits batches within the limit while keeping servers atomic', () => {
    const batches = planInferenceBatches([server('b', 70_000), server('a', 60_000), server('c', 50_000)], 120_000);

    expect(batches.map((batch) => batch.servers.map((item) => item.serverName))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
    expect(batches.map((batch) => batch.payloadTokens)).toEqual([60_000, 120_000]);
  });

  it('reflects the 120k Claude and 200k Codex limits through the maxPayloadTokens the caller passes', () => {
    expect(planInferenceBatches([server('a', 100_000), server('b', 90_000)], 120_000)).toHaveLength(2);
    expect(planInferenceBatches([server('a', 100_000), server('b', 90_000)], 200_000)).toHaveLength(1);
  });

  it('puts a single oversized server in its own batch and marks oversized=true', () => {
    const batches = planInferenceBatches([server('small', 1_000), server('huge', 200_001)], 200_000);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ oversized: true, payloadTokens: 200_001 });
    expect(batches[0]!.servers.map((item) => item.serverName)).toEqual(['huge']);
  });
});
