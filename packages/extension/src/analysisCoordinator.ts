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

  async analyze(reanalyzeServerNames: readonly string[] = []): Promise<void> {
    const resolution = this.deps.resolve();
    if (resolution.kind === 'unavailable') return;
    if (resolution.kind === 'choose') return;
    const store = this.deps.store();
    const consent = store.currentInferenceConsent(CONSENT_POLICY_VERSION);
    if (consent === null || consent.status !== 'accepted'
      || consent.provider !== resolution.provider || consent.model !== resolution.model) {
      await this.deps.requestConsent?.({ provider: resolution.provider, model: resolution.model });
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
      provider: resolution.provider,
      model: resolution.model,
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
