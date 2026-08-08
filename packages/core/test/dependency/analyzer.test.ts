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
    outputSchemaJson: null,
    definitionTokens: tokens,
    definitionSetHash: hash,
    scannedAt: NOW,
  };
}

interface SchemaBodyOptions {
  description?: string | null;
  properties?: Record<string, unknown>;
  required?: string[];
  outputSchema?: unknown;
}

function schemaBody(
  serverName: string,
  hash: string,
  toolName: string,
  options: SchemaBodyOptions = {},
): ToolDefinitionBody {
  return {
    ...body(serverName, hash, 10, toolName),
    description: options.description ?? null,
    inputSchemaJson: JSON.stringify({
      type: 'object',
      properties: options.properties ?? {},
      required: options.required ?? [],
    }),
    outputSchemaJson: options.outputSchema === undefined ? null : JSON.stringify(options.outputSchema),
  };
}

function ingestSessions(store: LensStore, serverName: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const sessionId = `${serverName}-s${index}`;
    store.ingest({
      session: { sessionId, client: 'codex', filePath: null, startedAt: NOW, mode: 'UPFRONT' },
      toolCalls: [{
        sessionId, serverName, toolName: 'read', calledAt: '2026-08-02T00:00:00.000Z',
        durationMs: null, isError: false, responseTokens: null, responseText: null,
      }],
      toolLoads: [], usage: [], parseErrors: 0,
    });
  }
}

async function staleServers(
  names: readonly string[],
  storedSessionCount = 0,
  sessions = 5,
): Promise<LensStore> {
  const store = await LensStore.open(':memory:');
  for (const name of names) {
    store.upsertDefinitionBodies([body(name, `${name}-v1`)]);
    store.saveDependencyAnalysis(complete(`${name}-v1`, name, 1, storedSessionCount));
    ingestSessions(store, name, sessions);
  }
  return store;
}

function complete(
  hash: string,
  serverName: string,
  rulesVersion = 1,
  observedSessionCount = 0,
): DependencyAnalysis {
  return {
    definitionSetHash: hash,
    analysisRulesVersion: rulesVersion,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    status: 'complete',
    analyzedAt: NOW,
    errorCode: null,
    observedSessionCount,
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
  it('reuses only the same hash+rulesVersion and misses only servers whose definitions or rulesVersion changed', async () => {
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

  it('packs several missed servers up to the provider budget and stores the analysis per server hash', async () => {
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

  it('stores only the servers of a failed batch as failed, preserving other batches and the existing cache, and never retries', async () => {
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

  it('puts the static and call-chain aggregates in the payload and merges the validated LLM result', async () => {
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

  it('never calls the runner when consent is absent or revoked and the provider is unavailable', async () => {
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

  it('downgrades a schema-flow producer to Review required', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      schemaBody('alpha', 'alpha-v1', 'search_restaurants', { description: 'Find places to eat.' }),
      schemaBody('alpha', 'alpha-v1', 'book_reservation', {
        description: 'Reserve a table.',
        properties: { restaurant_id: { type: 'string' } },
        required: ['restaurant_id'],
      }),
    ]);

    await analyzeUncachedServers(await input(store), successfulRunner([]));

    const producer = store.findDependencyAnalysis('alpha-v1', 1)!
      .results.find((row) => row.toolName === 'search_restaurants')!;
    expect(producer.status).toBe('Review required');
    expect(producer.dependedOnBy).toEqual(['book_reservation']);
  });

  it('keeps a tool Independent when two producers exist', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      schemaBody('alpha', 'alpha-v1', 'find_places', {
        outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } },
      }),
      schemaBody('alpha', 'alpha-v1', 'list_places', {
        outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } },
      }),
      schemaBody('alpha', 'alpha-v1', 'book_reservation', {
        properties: { restaurant_id: { type: 'string' } },
        required: ['restaurant_id'],
      }),
    ]);

    await analyzeUncachedServers(await input(store), successfulRunner([]));

    const producer = store.findDependencyAnalysis('alpha-v1', 1)!
      .results.find((row) => row.toolName === 'find_places')!;
    expect(producer.status).toBe('Independent');
  });

  it('passes state consumer hints into the inference payload', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      schemaBody('alpha', 'alpha-v1', 'read_page', { description: 'Read the current page.' }),
      schemaBody('alpha', 'alpha-v1', 'navigate', {
        description: 'Open a URL.',
        properties: { url: { type: 'string' } },
        required: ['url'],
      }),
    ]);
    const batches: InferenceBatch[] = [];

    await analyzeUncachedServers(await input(store), successfulRunner(batches));

    expect(batches[0]!.servers[0]!.stateConsumers[0]!.toolName).toBe('read_page');
  });

  it('downgrades a tool named in predictedPrerequisites', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([
      schemaBody('alpha', 'alpha-v1', 'read_page', { description: 'Read the current page.' }),
      schemaBody('alpha', 'alpha-v1', 'navigate', {
        description: 'Open a URL.',
        properties: { url: { type: 'string' } },
        required: ['url'],
      }),
    ]);
    const run: InferenceRunner = vi.fn(async ({ batch }) => ({
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
        predictedPrerequisites: [{
          toolName: 'read_page',
          requires: ['navigate'],
          basis: 'read_page reports on whatever navigate opened.',
        }],
      },
    }));

    await analyzeUncachedServers(await input(store), run);

    const navigate = store.findDependencyAnalysis('alpha-v1', 1)!
      .results.find((row) => row.toolName === 'navigate')!;
    expect(navigate.status).toBe('Review required');
    expect(navigate.rationale).toContain('llm-prereq:read_page');
  });

  it('reanalyzes a cached verdict once sessions cross the threshold', async () => {
    const store = await staleServers(['s'], 0, 3);
    const run = successfulRunner([]);

    const result = await analyzeUncachedServers(await input(store, { serverNames: ['s'] }), run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.cachedServerNames).toEqual([]);
  });

  it('keeps using the cache when sessions are still below the threshold', async () => {
    const store = await staleServers(['s'], 0, 2);
    const run = successfulRunner([]);

    const result = await analyzeUncachedServers(await input(store, { serverNames: ['s'] }), run);

    expect(run).not.toHaveBeenCalled();
    expect(result.cachedServerNames).toEqual(['s']);
  });

  it('does not reanalyze a server that already had enough sessions', async () => {
    const store = await staleServers(['s'], 5, 50);
    const run = successfulRunner([]);

    await analyzeUncachedServers(await input(store, { serverNames: ['s'] }), run);

    expect(run).not.toHaveBeenCalled();
  });

  it('stores the observed session count with the verdict', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([body('s', 's-v1')]);
    ingestSessions(store, 's', 3);

    await analyzeUncachedServers(await input(store, { serverNames: ['s'] }), successfulRunner([]));

    expect(store.findDependencyAnalysis('s-v1', 1)?.observedSessionCount).toBe(3);
  });

  it('does not apply the trigger to a failed analysis', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitionBodies([body('s', 's-v1')]);
    store.saveDependencyAnalysis({
      ...complete('s-v1', 's'), status: 'failed', errorCode: 'timeout', results: [],
    });
    ingestSessions(store, 's', 10);
    const run = successfulRunner([]);

    const result = await analyzeUncachedServers(await input(store, { serverNames: ['s'] }), run);

    expect(run).not.toHaveBeenCalled();
    expect(result.failedServerNames).toEqual(['s']);
  });

  it('wakes at most one cached verdict when a budget is given', async () => {
    const store = await staleServers(['a', 'b', 'c']);

    const result = await analyzeUncachedServers(await input(store, {
      serverNames: ['a', 'b', 'c'], maxTriggeredReanalyses: 1,
    }), successfulRunner([]));

    expect(result.analyzedServerNames).toEqual(['a']);
    expect(result.cachedServerNames).toEqual(['b', 'c']);
  });

  it('wakes every stale verdict when no budget is given', async () => {
    const store = await staleServers(['a', 'b', 'c']);

    const result = await analyzeUncachedServers(await input(store, {
      serverNames: ['a', 'b', 'c'],
    }), successfulRunner([]));

    expect(result.analyzedServerNames).toEqual(['a', 'b', 'c']);
    expect(result.cachedServerNames).toEqual([]);
  });

  it('does not charge a brand-new server against the budget', async () => {
    const store = await staleServers(['b']);
    store.upsertDefinitionBodies([body('a', 'a-v1')]);

    const result = await analyzeUncachedServers(await input(store, {
      serverNames: ['a', 'b'], maxTriggeredReanalyses: 1,
    }), successfulRunner([]));

    expect(result.analyzedServerNames).toEqual(['a', 'b']);
  });

  it('does not consume the budget when nothing is stale', async () => {
    const store = await staleServers(['a', 'b', 'c'], 5, 5);
    const run = successfulRunner([]);

    const result = await analyzeUncachedServers(await input(store, {
      serverNames: ['a', 'b', 'c'], maxTriggeredReanalyses: 1,
    }), run);

    expect(run).not.toHaveBeenCalled();
    expect(result.cachedServerNames).toHaveLength(3);
  });

  it('picks the budgeted server deterministically', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await staleServers(['a', 'b', 'c']);

      const result = await analyzeUncachedServers(await input(store, {
        serverNames: ['a', 'b', 'c'], maxTriggeredReanalyses: 1,
      }), successfulRunner([]));

      expect(result.analyzedServerNames).toEqual(['a']);
    }
  });
});
