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
  /** 제공자별 모델 이름. 자동 경로에서 'choose'를 스스로 풀 때만 쓴다. */
  modelFor?: (provider: 'claude' | 'codex') => string;
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
   * @param options.auto 스캔 직후 자동으로 도는 호출이다. 사람이 답할 자리가 없으므로
   *   동의창을 띄우지 않고, 이미 받아 둔 동의가 없으면 분석을 건너뛴다. 제공자가 둘 다
   *   있으면 묻는 대신 첫 번째(claude)를 고른다.
   *   자동 분석을 끄는 스위치는 mcpLens.autoAnalyze 설정이며, 호출자가 그것을 본다.
   */
  async analyze(
    reanalyzeServerNames: readonly string[] = [],
    options: { auto?: boolean } = {},
  ): Promise<void> {
    const resolution = this.deps.resolve();
    if (resolution.kind === 'unavailable') return;
    // 'choose'는 사람에게 묻는 상태다. 자동 경로에는 물을 자리가 없으므로 정해둔
    // 우선순위로 고른다. 사용자가 특정 제공자를 원하면 mcpLens.inferenceProvider로 못 박는다.
    const chosen = resolution.kind === 'resolved'
      ? { provider: resolution.provider, model: resolution.model }
      : options.auto && this.deps.modelFor
        ? { provider: resolution.choices[0], model: this.deps.modelFor(resolution.choices[0]) }
        : null;
    if (chosen === null) return;
    const store = this.deps.store();
    const consent = store.currentInferenceConsent(CONSENT_POLICY_VERSION);
    const usable = consent !== null && consent.status === 'accepted'
      && consent.provider === chosen.provider && consent.model === chosen.model;
    if (!usable) {
      // 자동 경로는 묻지 않는 대신, 사용자가 아직 제공자를 고르고 동의한 적이 없으면
      // 그냥 멈춘다. 여기서 대신 골라 주면 워크스루의 제공자 선택이 무의미해지고,
      // 사용자가 승낙한 적 없는 계정에서 토큰이 나간다. 철회한 경우도 같다.
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
