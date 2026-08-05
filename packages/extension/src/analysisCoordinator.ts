import {
  analyzeUncachedServers,
  type InferenceRunner,
  type LensStore,
} from '@mcp-lens/core';
import type { ProviderResolution } from './providerConfig.js';

export const ANALYSIS_RULES_VERSION = 1;
export const CONSENT_POLICY_VERSION = 1;

export interface AnalysisCoordinatorDeps {
  store: () => LensStore;
  serverNames: () => readonly string[];
  resolve: () => ProviderResolution;
  run: InferenceRunner;
  requestConsent?: (choice: { provider: 'claude' | 'codex'; model: string }) => void | Promise<void>;
  onRefresh?: () => void;
}

/** Coordinates user-initiated analysis; activation is deliberately cache-only. */
export class AnalysisCoordinator {
  private generation = 0;
  private controller: AbortController | undefined;

  constructor(private readonly deps: AnalysisCoordinatorDeps) {}

  async refreshCache(): Promise<void> {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.deps.onRefresh?.();
  }

  /**
   * @param options.auto This call runs automatically right after a scan. There is nowhere for a
   *   human to answer, so no consent dialog is shown and the provider and model the user chose and
   *   consented to during onboarding are used as they are.
   *   Without any prior consent, the analysis is skipped.
   */
  async analyze(
    reanalyzeServerNames: readonly string[] = [],
    options: { auto?: boolean } = {},
  ): Promise<void> {
    const resolution = this.deps.resolve();
    if (resolution.kind === 'unavailable') return;
    const store = this.deps.store();
    const consent = store.currentInferenceConsent(CONSENT_POLICY_VERSION);
    const accepted = consent !== null && consent.status === 'accepted' ? consent : null;
    // 'choose' means both providers are installed and a human is being asked. The automatic path has
    // nowhere to ask, so it uses the provider the user already chose and consented to during
    // onboarding. Picking by some arbitrary priority here would ignore a user who chose Codex and,
    // clashing with their consent, silently skip the analysis forever.
    const chosen = resolution.kind === 'resolved'
      ? { provider: resolution.provider, model: resolution.model }
      : options.auto && accepted && resolution.choices.includes(accepted.provider)
        ? { provider: accepted.provider, model: accepted.model }
        : null;
    if (chosen === null) return;
    const usable = accepted !== null
      && accepted.provider === chosen.provider && accepted.model === chosen.model;
    if (!usable) {
      // Instead of asking, the automatic path simply stops when the user has never chosen a provider
      // and consented. Choosing for them here would make the walkthrough's provider selection
      // tokens from an account that never approved it. The same holds after a withdrawal.
      if (options.auto) return;
      await this.deps.requestConsent?.({ provider: chosen.provider, model: chosen.model });
      return;
    }

    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const result = await analyzeUncachedServers({
      store,
      serverNames: this.deps.serverNames(),
      analysisRulesVersion: ANALYSIS_RULES_VERSION,
      consentPolicyVersion: CONSENT_POLICY_VERSION,
      provider: chosen.provider,
      model: chosen.model,
      reanalyzeServerNames,
      signal: controller.signal,
    }, async (request) => {
      if (controller.signal.aborted) return { ok: false, errorCode: 'cancelled' };
      return this.deps.run(request);
    });
    if (controller.signal.aborted || generation !== this.generation) return;
    if (result.status === 'complete') store.save();
    this.deps.onRefresh?.();
  }
}
