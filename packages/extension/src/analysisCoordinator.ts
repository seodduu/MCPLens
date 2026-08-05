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
  /**
   * 자동 경로에서 묻지 않고 남기는 동의 기록. core의 분석 게이트가 이 기록을 요구하고,
   * 무엇을 어떤 제공자·모델로 보냈는지의 감사 흔적이 된다.
   */
  recordAutoConsent?: (choice: { provider: 'claude' | 'codex'; model: string }) => void;
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
   *   동의창을 띄우지 않고, 제공자가 둘 다 있으면 묻는 대신 첫 번째(claude)를 고른다.
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
      if (!options.auto) {
        await this.deps.requestConsent?.({ provider: chosen.provider, model: chosen.model });
        return;
      }
      // 사용자가 명시적으로 철회했으면 자동 경로도 멈춘다. 철회가 다음 스캔에 조용히
      // 뒤집히면 그건 철회가 아니다. 다시 켜려면 분석 커맨드를 직접 실행한다.
      if (consent?.status === 'revoked') return;
      // core(analyzeUncachedServers)도 같은 동의를 확인하므로 기록 없이는 진행할 수 없다.
      // 자동 경로는 묻지 않는 대신 무엇을 어떤 제공자로 보냈는지 기록을 남긴다.
      this.deps.recordAutoConsent?.({ provider: chosen.provider, model: chosen.model });
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
