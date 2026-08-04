import { describe, expect, it, vi } from 'vitest';
import {
  analyzeUncachedServers,
  type AnalyzeServersInput,
  type InferenceRunner,
} from '../../src/dependency/analyzer.js';
import type { InferenceBatch } from '../../src/inference/types.js';
import { LensStore } from '../../src/store/store.js';
import type { DependencyAnalysis, ToolDefinitionBody } from '../../src/types.js';

const NOW = '2026-08-03T00:00:00.000Z';

function body(serverName: string, hash: string, tokens = 10, toolName = 'read'): ToolDefinitionBody {
  return {
    serverName,
    toolName,
    description: `Run ${toolName}`,
    inputSchemaJson: '{"type":"object"}',
    definitionTokens: tokens,
    definitionSetHash: hash,
    scannedAt: NOW,
  };
}

function complete(hash: string, serverName: string, rulesVersion = 1): DependencyAnalysis {
  return {
    definitionSetHash: hash,
    analysisRulesVersion: rulesVersion,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    status: 'complete',
    analyzedAt: NOW,
    errorCode: null,
    results: [{
      serverName,
      toolName: 'read',
      status: 'Independent',
      dependedOnBy: [],
      rationale: 'No dependency was found.',
      displaySummary: 'Reads data.',
      whatYouLose: 'Direct data lookup.',
      riskWithoutTool: 'Manual lookup is required.',
    }],
  };
}

function successfulRunner(batches: InferenceBatch[]): InferenceRunner {
  return vi.fn(async ({ batch }) => {
    batches.push(batch);
    return {
      ok: true as const,
      value: {
        results: batch.servers.flatMap((server) => server.tools.map((tool) => ({
          serverName: server.serverName,
          toolName: tool.toolName,
          status: 'Independent',
          dependedOnBy: [],
          rationale: 'No dependency was found.',
          displaySummary: 'Reads data.',
          whatYouLose: 'Direct data lookup.',
          riskWithoutTool: 'Manual lookup is required.',
        }))),
      },
    };
  });
}

async function input(
  store: LensStore,
  overrides: Partial<AnalyzeServersInput> = {},
): Promise<AnalyzeServersInput> {
  const provider = overrides.provider === 'claude' ? 'claude' : 'codex';
  const model = overrides.model ?? (provider === 'claude' ? 'haiku' : 'gpt-5.6-luna');
  store.saveInferenceConsent({
    policyVersion: 1,
    provider,
    model,
    status: 'accepted',
    acceptedAt: NOW,
    revokedAt: null,
  });
  return {
    store,
    serverNames: ['alpha'],
    analysisRulesVersion: 1,
    consentPolicyVersion: 1,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    now: NOW,
    ...overrides,
  };
}

describe('analyzeUncachedServers', () => {
  it('같은 hash+rulesVersion만 재사용하고 정의나 rulesVersion이 바뀐 서버만 miss 처리한다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([body('alpha', 'alpha-v1'), body('beta', 'beta-v1')]);
    store.saveDependencyAnalysis(complete('alpha-v1', 'alpha'));
    store.saveDependencyAnalysis(complete('beta-v1', 'beta'));
    const batches: InferenceBatch[] = [];
    const run = successfulRunner(batches);

    const cached = await analyzeUncachedServers(await input(store, {
      serverNames: ['alpha', 'beta'],
    }), run);
    expect(cached).toMatchObject({ status: 'complete', cachedServerNames: ['alpha', 'beta'], batchCount: 0 });
    expect(run).not.toHaveBeenCalled();

    store.upsertDefinitionBodies([body('beta', 'beta-v2')]);
    const changed = await analyzeUncachedServers(await input(store, {
      serverNames: ['alpha', 'beta'],
    }), run);
    expect(changed).toMatchObject({ cachedServerNames: ['alpha'], analyzedServerNames: ['beta'], batchCount: 1 });

    batches.length = 0;
    const newRules = await analyzeUncachedServers(await input(store, {
      serverNames: ['alpha', 'beta'], analysisRulesVersion: 2,
    }), run);
    expect(newRules).toMatchObject({ cachedServerNames: [], analyzedServerNames: ['alpha', 'beta'], batchCount: 1 });
    expect(batches[0]!.servers.map((server) => server.serverName)).toEqual(['alpha', 'beta']);
  });

  it('여러 miss 서버를 provider budget까지 합치고 분석은 서버 hash별로 저장한다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      body('alpha', 'alpha-v1', 70_000),
      body('beta', 'beta-v1', 50_000),
      body('gamma', 'gamma-v1', 1),
    ]);
    const batches: InferenceBatch[] = [];

    const result = await analyzeUncachedServers(await input(store, {
      serverNames: ['gamma', 'beta', 'alpha'], provider: 'claude', model: 'haiku',
    }), successfulRunner(batches));

    expect(result.batchCount).toBe(2);
    expect(batches.map((batch) => batch.servers.map((server) => server.serverName))).toEqual([
      ['alpha', 'beta'],
      ['gamma'],
    ]);
    expect(store.findDependencyAnalysis('alpha-v1', 1)?.results[0]?.serverName).toBe('alpha');
    expect(store.findDependencyAnalysis('beta-v1', 1)?.results[0]?.serverName).toBe('beta');
    expect(store.findDependencyAnalysis('gamma-v1', 1)?.results[0]?.serverName).toBe('gamma');
  });

  it('실패 batch의 서버만 failed로 저장하고 다른 batch와 기존 cache를 보존하며 재시도하지 않는다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      body('alpha', 'alpha-v1', 70_000),
      body('beta', 'beta-v1', 60_000),
      body('cached', 'cached-v1', 1),
    ]);
    store.saveDependencyAnalysis(complete('cached-v1', 'cached'));
    const run = vi.fn<InferenceRunner>(async ({ batch }) => batch.servers[0]!.serverName === 'alpha'
      ? { ok: false as const, errorCode: 'timeout' }
      : successfulRunner([])({ provider: 'claude', model: 'haiku', batch }));

    const first = await analyzeUncachedServers(await input(store, {
      serverNames: ['alpha', 'beta', 'cached'], provider: 'claude', model: 'haiku',
    }), run);

    expect(first).toMatchObject({
      cachedServerNames: ['cached'], analyzedServerNames: ['beta'], failedServerNames: ['alpha'], batchCount: 2,
    });
    expect(store.findDependencyAnalysis('alpha-v1', 1)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(store.findDependencyAnalysis('beta-v1', 1)?.status).toBe('complete');
    expect(store.findDependencyAnalysis('cached-v1', 1)).toEqual(complete('cached-v1', 'cached'));

    run.mockClear();
    const second = await analyzeUncachedServers(await input(store, {
      serverNames: ['alpha', 'beta', 'cached'], provider: 'claude', model: 'haiku',
    }), run);
    expect(second.failedServerNames).toEqual(['alpha']);
    expect(run).not.toHaveBeenCalled();

    run.mockImplementation(successfulRunner([]));
    await analyzeUncachedServers(await input(store, {
      serverNames: ['alpha'], provider: 'claude', model: 'haiku', reanalyzeServerNames: ['alpha'],
    }), run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.findDependencyAnalysis('alpha-v1', 1)?.status).toBe('complete');
  });

  it('정적·call-chain 집계를 payload에 넣고 검증된 LLM 결과와 병합한다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      { ...body('alpha', 'alpha-v1', 10, 'prepare'), description: 'Prepare data.' },
      { ...body('alpha', 'alpha-v1', 10, 'publish'), description: 'Run prepare before publishing.' },
    ]);
    for (const [index, sessionId] of ['s1', 's2', 's3'].entries()) {
      store.ingest({
        session: { sessionId, client: 'codex', filePath: null, startedAt: NOW, mode: 'UPFRONT' },
        toolCalls: [
          { sessionId, serverName: 'alpha', toolName: 'prepare', calledAt: `2026-08-02T00:00:0${index}.000Z`, durationMs: null, isError: false, responseTokens: null, responseText: null },
          { sessionId, serverName: 'alpha', toolName: 'publish', calledAt: `2026-08-02T00:01:0${index}.000Z`, durationMs: null, isError: false, responseTokens: null, responseText: null },
        ],
        toolLoads: [], usage: [], parseErrors: 0,
      });
    }
    const batches: InferenceBatch[] = [];

    await analyzeUncachedServers(await input(store), successfulRunner(batches));

    const prepare = batches[0]!.servers[0]!.tools.find((tool) => tool.toolName === 'prepare')!;
    expect(prepare.staticReferences).toEqual(['publish']);
    expect(prepare.callChainSummary).toEqual([{
      targetServerName: 'alpha', targetToolName: 'publish', sessionCount: 3, beforeRate: 1,
    }]);
    expect(store.findDependencyAnalysis('alpha-v1', 1)?.results.find((item) => item.toolName === 'prepare')).toMatchObject({
      status: 'Review required', dependedOnBy: ['publish'],
      displaySummary: null, whatYouLose: null, riskWithoutTool: null,
    });
  });

  it('동의가 없거나 revoked이고 provider가 unavailable이면 runner를 호출하지 않는다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([body('alpha', 'alpha-v1')]);
    const run = successfulRunner([]);
    const base: AnalyzeServersInput = {
      store, serverNames: ['alpha'], analysisRulesVersion: 1, consentPolicyVersion: 1,
      provider: 'codex', model: 'gpt-5.6-luna', now: NOW,
    };

    await expect(analyzeUncachedServers(base, run)).resolves.toMatchObject({ status: 'consent-required' });
    store.saveInferenceConsent({
      policyVersion: 1, provider: 'codex', model: 'gpt-5.6-luna', status: 'revoked',
      acceptedAt: NOW, revokedAt: '2026-08-03T00:00:01.000Z',
    });
    await expect(analyzeUncachedServers(base, run)).resolves.toMatchObject({ status: 'consent-required' });
    await expect(analyzeUncachedServers({ ...base, provider: 'unavailable' }, run)).resolves.toMatchObject({ status: 'provider-unavailable' });
    expect(run).not.toHaveBeenCalled();
  });
});
