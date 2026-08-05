import { describe, expect, it, vi } from 'vitest';
import type { InferenceRunnerRequest } from '@mcp-lens/core';
import { AnalysisCoordinator } from '../src/analysisCoordinator.js';

const body = {
  serverName: 'docs', toolName: 'search', description: 'Search docs', inputSchemaJson: '{}',
  definitionTokens: 10, definitionSetHash: 'a'.repeat(64), scannedAt: '2026-08-03T00:00:00.000Z',
};

function store(consent: unknown = null) {
  return {
    definitionBodiesForServer: vi.fn(() => [body]),
    currentInferenceConsent: vi.fn(() => consent),
    dependencyCallsSince: vi.fn(() => []),
    findDependencyAnalysis: vi.fn(() => null),
    saveDependencyAnalysis: vi.fn(),
  };
}

describe('AnalysisCoordinator', () => {
  it('does not invoke inference while reading activation cache state', async () => {
    const run = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store(), serverNames: () => ['docs'], resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }), run,
    });

    await coordinator.refreshCache();
    expect(run).not.toHaveBeenCalled();
  });

  it('opens re-consent instead of running when stored provider or model is stale', async () => {
    const requestConsent = vi.fn();
    const run = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store({ policyVersion: 1, provider: 'claude', model: 'old', status: 'accepted', acceptedAt: '', revokedAt: null }),
      serverNames: () => ['docs'], resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }), run, requestConsent,
    });

    await coordinator.analyze();
    expect(run).not.toHaveBeenCalled();
    expect(requestConsent).toHaveBeenCalledWith({ provider: 'claude', model: 'haiku' });
  });

  // 스캔 직후 자동으로 도는 경로. 사람이 답할 자리가 없으므로 동의창을 띄우지 않는다.
  // 대신 제공자 CLI 토큰을 쓰므로 mcpLens.autoAnalyze로 끄고, 호출자가 그 설정을 본다.
  it('runs without asking for consent on the automatic path', async () => {
    const requestConsent = vi.fn();
    const recordAutoConsent = vi.fn();
    const run = vi.fn(async () => ({ ok: true as const, value: { results: [] } }));
    // 자동 경로가 기록을 남긴 뒤에는 core 게이트가 통과해야 하므로, 기록 이후를 반영한다.
    let consent: unknown = null;
    const testStore = { ...store(), save: vi.fn(), currentInferenceConsent: () => consent };
    const coordinator = new AnalysisCoordinator({
      store: () => testStore as never,
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run, requestConsent,
      recordAutoConsent: (choice) => {
        recordAutoConsent(choice);
        consent = { policyVersion: 1, ...choice, status: 'accepted', acceptedAt: '', revokedAt: null };
      },
    });

    await coordinator.analyze([], { auto: true });
    expect(requestConsent).not.toHaveBeenCalled();
    expect(recordAutoConsent).toHaveBeenCalledWith({ provider: 'claude', model: 'haiku' });
    expect(run).toHaveBeenCalled();
  });

  // 철회가 다음 스캔에 조용히 뒤집히면 그건 철회가 아니다.
  it('respects an explicit withdrawal on the automatic path', async () => {
    const run = vi.fn();
    const recordAutoConsent = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store({ policyVersion: 1, provider: 'claude', model: 'haiku', status: 'revoked', acceptedAt: '', revokedAt: '2026-08-05T00:00:00.000Z' }),
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run, recordAutoConsent,
    });

    await coordinator.analyze([], { auto: true });
    expect(recordAutoConsent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  // 제공자가 둘 다 깔려 있으면 수동 경로는 사람에게 고르라고 묻는다.
  // 자동 경로에는 물을 자리가 없으므로 정해둔 우선순위(첫 번째 = claude)로 고른다.
  it('picks the first provider instead of asking when both are available', async () => {
    const run = vi.fn(async () => ({ ok: true as const, value: { results: [] } }));
    const modelFor = vi.fn((provider: 'claude' | 'codex') => provider === 'claude' ? 'haiku' : 'gpt');
    let consent: unknown = null;
    const testStore = { ...store(), save: vi.fn(), currentInferenceConsent: () => consent };
    const coordinator = new AnalysisCoordinator({
      store: () => testStore as never, serverNames: () => ['docs'],
      resolve: () => ({ kind: 'choose', choices: ['claude', 'codex'] }),
      modelFor, run,
      recordAutoConsent: (choice) => {
        consent = { policyVersion: 1, ...choice, status: 'accepted', acceptedAt: '', revokedAt: null };
      },
    });

    await coordinator.analyze([], { auto: true });
    expect(run).toHaveBeenCalled();
    expect(modelFor).toHaveBeenCalledWith('claude');
  });

  it('still asks a human to choose on the manual path', async () => {
    const run = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store(), serverNames: () => ['docs'],
      resolve: () => ({ kind: 'choose', choices: ['claude', 'codex'] }),
      modelFor: () => 'haiku', run,
    });

    await coordinator.analyze();
    expect(run).not.toHaveBeenCalled();
  });

  it('discards an earlier analysis completion after a newer refresh generation', async () => {
    let complete!: (value: { ok: true; value: unknown }) => void;
    const run = vi.fn(() => new Promise<{ ok: true; value: unknown }>((resolve) => { complete = resolve; }));
    const onRefresh = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store({ policyVersion: 1, provider: 'claude', model: 'haiku', status: 'accepted', acceptedAt: '', revokedAt: null }),
      serverNames: () => ['docs'], resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }), run, onRefresh,
    });

    const pending = coordinator.analyze();
    await Promise.resolve();
    await coordinator.refreshCache();
    onRefresh.mockClear();
    complete({ ok: true, value: { results: [] } });
    await pending;
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('aborts the in-flight inference and does not save its cancelled result', async () => {
    let resolveRun!: (value: { ok: true; value: unknown }) => void;
    let receivedSignal: AbortSignal | undefined;
    let signalReceived!: () => void;
    const signalReceivedPromise = new Promise<void>((resolve) => { signalReceived = resolve; });
    const run = vi.fn((request: InferenceRunnerRequest) => {
      receivedSignal = request.signal;
      signalReceived();
      return new Promise<{ ok: true; value: unknown }>((resolve) => { resolveRun = resolve; });
    });
    const testStore = store({ policyVersion: 1, provider: 'claude', model: 'haiku', status: 'accepted', acceptedAt: '', revokedAt: null });
    const save = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => ({ ...testStore, save } as never),
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run,
    });

    const pending = coordinator.analyze();
    await signalReceivedPromise;
    expect(receivedSignal).toBeDefined();
    await coordinator.refreshCache();
    expect(receivedSignal!.aborted).toBe(true);
    resolveRun({ ok: true, value: { results: [] } });
    await pending;

    expect(testStore.saveDependencyAnalysis).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
