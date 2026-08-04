import type { InferenceCostEstimate, InferenceProvider } from './types.js';

const RATES_PER_MTOK: Record<InferenceProvider, { input: number; output: number }> = {
  codex: { input: 0.20, output: 1.20 },
  claude: { input: 1, output: 5 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function usd(tokens: number, ratePerMTok: number): number {
  return Number(((tokens / 1_000_000) * ratePerMTok).toFixed(6));
}

export function estimateInferenceCost(
  provider: InferenceProvider,
  definitionTokens: number,
  toolCount: number,
): InferenceCostEstimate {
  if (!Number.isFinite(definitionTokens) || definitionTokens < 0) {
    throw new Error('definitionTokens must be a non-negative finite number');
  }
  if (!Number.isInteger(toolCount) || toolCount < 0) {
    throw new Error('toolCount must be a non-negative integer');
  }

  const inputTokens = {
    min: definitionTokens + 20_000,
    max: definitionTokens + 35_000,
  };
  const outputTokens = {
    min: clamp(toolCount * 60, 1_000, 5_000),
    max: clamp(toolCount * 120, 2_000, 10_000),
  };
  const rate = RATES_PER_MTOK[provider];
  const inputUsd = {
    min: usd(inputTokens.min, rate.input),
    max: usd(inputTokens.max, rate.input),
  };
  const outputUsd = {
    min: usd(outputTokens.min, rate.output),
    max: usd(outputTokens.max, rate.output),
  };

  return {
    provider,
    rateDate: '2026-08-03',
    inputTokens,
    outputTokens,
    inputUsd,
    outputUsd,
    totalUsd: {
      min: Number((inputUsd.min + outputUsd.min).toFixed(6)),
      max: Number((inputUsd.max + outputUsd.max).toFixed(6)),
    },
    disclaimer: 'Rates are API-equivalent estimates dated 2026-08-03; actual CLI billing may differ.',
  };
}
