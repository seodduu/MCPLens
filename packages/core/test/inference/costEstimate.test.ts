import { describe, expect, it } from 'vitest';
import { estimateInferenceCost } from '../../src/inference/costEstimate.js';

describe('estimateInferenceCost', () => {
  it('adds a 20k..35k input allowance on top of the definition tokens', () => {
    const estimate = estimateInferenceCost('codex', 12_345, 3);

    expect(estimate.inputTokens).toEqual({ min: 32_345, max: 47_345 });
  });

  it('computes the output range as toolCount*60/120 and clamps it to 1k..5k and 2k..10k', () => {
    expect(estimateInferenceCost('codex', 0, 3).outputTokens).toEqual({ min: 1_000, max: 2_000 });
    expect(estimateInferenceCost('codex', 0, 200).outputTokens).toEqual({ min: 5_000, max: 10_000 });
  });

  it('returns the 2026-08-03 API-equivalent rate and the CLI billing caveat', () => {
    const codex = estimateInferenceCost('codex', 1_000_000, 100);
    const claude = estimateInferenceCost('claude', 1_000_000, 100);

    expect(codex.rateDate).toBe('2026-08-03');
    expect(codex.inputUsd.min).toBe(0.204);
    expect(codex.outputUsd.min).toBe(0.006);
    expect(claude.inputUsd.min).toBe(1.02);
    expect(claude.outputUsd.min).toBe(0.025);
    expect(codex.disclaimer).toMatch(/actual CLI billing may differ/i);
  });
});
