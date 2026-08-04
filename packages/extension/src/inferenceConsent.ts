import type { InferenceConsent } from '@mcp-lens/core';
import {
  readProviderConfig,
  resolveProvider,
  type ResolvedInferenceProvider,
} from './providerConfig.js';

export { readProviderConfig, resolveProvider } from './providerConfig.js';

export interface ConsentDialogInput {
  provider: ResolvedInferenceProvider;
  model: string;
  estimate: {
    inputTokens: { min: number; max: number };
    outputTokens: { min: number; max: number };
    totalUsd: { min: number; max: number };
    rateDate: string;
    disclaimer: string;
  };
}

export interface ConsentDialog {
  title: string;
  detail: string;
  canPersist: false;
  accept(acceptedAt: string): InferenceConsent;
}

const formatTokens = (tokens: number) => tokens.toLocaleString('en-US');
const formatUsd = (usd: number) => `$${usd.toFixed(6)}`;

export type ConsentPrompt = (
  title: string,
  options: { modal: true; detail: string },
  acceptLabel: 'Accept',
) => PromiseLike<string | undefined>;

/** Builds consent copy only; persistence is deliberately deferred to explicit acceptance. */
export function buildConsentDialog(input: ConsentDialogInput): ConsentDialog {
  return {
    title: 'Allow dependency analysis?',
    detail: [
      `Selected provider and model: ${input.provider} / ${input.model}.`,
      `Estimated input tokens: ${formatTokens(input.estimate.inputTokens.min)}–${formatTokens(input.estimate.inputTokens.max)}.`,
      `Estimated output tokens: ${formatTokens(input.estimate.outputTokens.min)}–${formatTokens(input.estimate.outputTokens.max)}.`,
      `Estimated API-equivalent cost: ${formatUsd(input.estimate.totalUsd.min)}–${formatUsd(input.estimate.totalUsd.max)} (rates dated ${input.estimate.rateDate}).`,
      'Actual billing depends on your CLI account and plan.',
      input.estimate.disclaimer,
      'Data sent for analysis: MCP tool definitions and aggregated usage statistics.',
      'Data never sent for analysis: prompts, tool inputs, tool outputs, source code, project paths, credentials.',
      'Cache is reused only for the same server definition set and analysis rules version; it is invalidated when definitions or rules change.',
      'You can withdraw consent at any time from MCP Lens.',
    ].join('\n\n'),
    canPersist: false,
    accept: (acceptedAt) => ({
      policyVersion: 1,
      provider: input.provider,
      model: input.model,
      status: 'accepted',
      acceptedAt,
      revokedAt: null,
    }),
  };
}

/** Prompts at the VS Code boundary without coupling this pure module to vscode. */
export async function requestInferenceConsent(
  input: ConsentDialogInput,
  prompt: ConsentPrompt,
  acceptedAt: () => string,
): Promise<InferenceConsent | null> {
  const dialog = buildConsentDialog(input);
  const choice = await prompt(dialog.title, { modal: true, detail: dialog.detail }, 'Accept');
  return choice === 'Accept' ? dialog.accept(acceptedAt()) : null;
}

/** Revocation prevents future inference; it deliberately does not alter cached analyses or actions. */
export function withdrawConsent(consent: InferenceConsent, revokedAt: string): InferenceConsent {
  return { ...consent, status: 'revoked', revokedAt };
}
