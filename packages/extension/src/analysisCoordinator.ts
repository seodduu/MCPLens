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
   * @param options.auto 스캔 직후 자동으로 도는 호출이다. 사람이 답할 자리가 없으므로
   *   동의창을 띄우지 않고, 사용자가 온보딩에서 고르고 동의한 제공자·모델을 그대로 쓴다.
   *   동의한 적이 없으면 분석을 건너뛴다.
   *   자동 분석을 끄는 스위치는 mcpLens.autoAnalyze 설정이며, 호출자가 그것을 본다.
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
    // 'choose'는 제공자가 둘 다 깔려 있어 사람에게 묻는 상태다. 자동 경로에는 물을 자리가
    // 없으므로, 사용자가 온보딩에서 이미 고르고 동의한 제공자를 그대로 쓴다. 여기서 임의의
    // 우선순위로 고르면 Codex를 고른 사용자의 선택이 무시되고, 동의와 어긋나 분석이 영영
    // 조용히 건너뛰어진다.
    const chosen = resolution.kind === 'resolved'
      ? { provider: resolution.provider, model: resolution.model }
      : options.auto && accepted && resolution.choices.includes(accepted.provider)
        ? { provider: accepted.provider, model: accepted.model }
        : null;
    if (chosen === null) return;
    const usable = accepted !== null
      && accepted.provider === chosen.provider && accepted.model === chosen.model;
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
