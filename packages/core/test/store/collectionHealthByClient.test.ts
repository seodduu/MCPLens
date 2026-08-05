import { describe, it, expect } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import type { ToolObservation } from '../../src/ingest/contracts.js';

async function seed() {
  const store = await LensStore.open(':memory:');
  const base = {
    schemaVersion: 1 as const,
    correlationConfidence: 'high' as const,
    externalTurnId: null, externalCallId: null,
    transcriptPath: null, serverName: 'github', durationMs: null, isError: null,
    responseTokens: null, loadedTokens: null, inputFingerprint: null,
  };
  // claude-code: hook and log match, so healthy
  store.upsertObservation({
    ...base, deliveryId: 'c-h', correlationKey: 'k1',
    source: 'hook', client: 'claude-code', phase: 'tool-after',
    externalSessionId: 's-c', toolName: 'x', observedAt: '2026-07-22T00:00:00.000Z',
    receivedAt: '2026-07-22T00:00:00.000Z',
  } satisfies ToolObservation);
  store.upsertObservation({
    ...base, deliveryId: 'c-l', correlationKey: 'k1',
    source: 'log', client: 'claude-code', phase: 'tool-after',
    externalSessionId: 's-c', toolName: 'x', observedAt: '2026-07-22T00:00:00.000Z',
    receivedAt: '2026-07-22T00:00:00.000Z',
  } satisfies ToolObservation);
  // codex: log only, so log-only
  store.upsertObservation({
    ...base, deliveryId: 'x-l', correlationKey: 'k2',
    source: 'log', client: 'codex', phase: 'tool-after',
    externalSessionId: 's-x', toolName: 'y', observedAt: '2026-07-22T00:00:00.000Z',
    receivedAt: '2026-07-22T00:00:00.000Z',
  } satisfies ToolObservation);
  return store;
}

describe('collectionHealthByClient', () => {
  it('derives health separately per client', async () => {
    const store = await seed();
    const byClient = store.collectionHealthByClient('2026-07-22T01:00:00.000Z');
    expect(byClient.get('claude-code')?.health).toBe('healthy');
    expect(byClient.get('codex')?.health).toBe('log-only');
    expect(byClient.has('gemini-cli')).toBe(false); // no observations
  });
});
