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

  // The path that runs automatically right after a scan. There is nowhere for a human to answer, so no consent dialog.
  // With consent already on file it runs without asking.
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

  // The first run belongs to the user. Choosing for them here would make the walkthrough's provider
  // selection meaningless and spend tokens from an account that never approved it.
  it('stays put on the automatic path when the user has never consented', async () => {
    const requestConsent = vi.fn();
    const run = vi.fn();
    const coordinator = new AnalysisCoordinator({
      store: () => store(),                      // no stored consent
      serverNames: () => ['docs'],
      resolve: () => ({ kind: 'resolved', provider: 'claude', model: 'haiku' }),
      run, requestConsent,
    });

    await coordinator.analyze([], { auto: true });
    expect(run).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();   // the automatic path does not even ask
  });

  // A withdrawal silently reversed by the next scan is not a withdrawal.
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

  // Measured regression: when the automatic path picks a provider by some arbitrary priority, the
  // choice of a user who picked Codex during onboarding is ignored. That choice also clashes with the
  // consent record, so the analysis is silently skipped forever. The automatic path must use the provider the user consented to.
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
