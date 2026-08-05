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
  // 이미 받아 둔 동의가 있으면 묻지 않고 그대로 돈다.
  it('runs without asking again when consent is already on file', async () => {
    const requestConsent = vi.fn();
    const run = vi.fn(async () => ({ ok: true as const, value: { results: [] } }));
    const testStore = {
      ...store({ policyVersion: 1, provider: 'claude', model: 'haiku', status: 'accepted', acceptedAt: '', revokedAt: null }),
      save: vi.fn(),
    };
    const coordinator = new AnalysisCoordinator({
      store: () => testStore as never,
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run, requestConsent,
    });

    await coordinator.analyze([], { auto: true });
    expect(requestConsent).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  // 첫 실행은 사용자 몫이다. 여기서 확장이 대신 고르면 워크스루의 제공자 선택이
  // 무의미해지고, 승낙한 적 없는 계정에서 토큰이 나간다.
  it('stays put on the automatic path when the user has never consented', async () => {
    const requestConsent = vi.fn();
    const run = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store(),                      // 저장된 동의 없음
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run, requestConsent,
    });

    await coordinator.analyze([], { auto: true });
    expect(run).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();   // 자동 경로는 묻지도 않는다
  });

  // 철회가 다음 스캔에 조용히 뒤집히면 그건 철회가 아니다.
  it('respects an explicit withdrawal on the automatic path', async () => {
    const run = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store({ policyVersion: 1, provider: 'claude', model: 'haiku', status: 'revoked', acceptedAt: '', revokedAt: '2026-08-05T00:00:00.000Z' }),
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run,
    });

    await coordinator.analyze([], { auto: true });
    expect(run).not.toHaveBeenCalled();
  });

  // 실측 회귀: 자동 경로가 임의의 우선순위로 제공자를 고르면, 온보딩에서 Codex를 고른
  // 사용자의 선택이 무시된다. 게다가 그 선택은 동의 기록과 어긋나므로 분석이 영영
  // 조용히 건너뛰어진다. 자동 경로는 사용자가 동의한 제공자를 그대로 써야 한다.
  it('uses the provider the user consented to when both are available', async () => {
    const run = vi.fn(async () => ({ ok: true as const, value: { results: [] } }));
    const testStore = {
      ...store({ policyVersion: 1, provider: 'codex', model: 'gpt', status: 'accepted', acceptedAt: '', revokedAt: null }),
      save: vi.fn(),
    };
    const coordinator = new AnalysisCoordinator({
      store: () => testStore as never, serverNames: () => ['docs'],
      resolve: () => ({ kind: 'choose', choices: ['claude', 'codex'] }),
      run,
    });

    await coordinator.analyze([], { auto: true });
    expect(run).toHaveBeenCalled();
    const request = run.mock.calls[0][0] as { provider: string; model: string };
    expect(request.provider).toBe('codex');
    expect(request.model).toBe('gpt');
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
