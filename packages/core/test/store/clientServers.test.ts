// packages/core/test/store/clientServers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import { splitByClient } from '../../src/engine/engine.js';
import type { ClientId } from '../../src/types.js';

const attr = (pairs: Array<[string, ClientId[]]>) =>
  new Map(pairs.map(([name, clients]) => [name, new Set(clients)]));

describe('client_servers', () => {
  it('returns an empty map on an empty DB', async () => {
    const store = await LensStore.open(':memory:');
    expect(store.serversByClient().size).toBe(0);
  });

  it('stores attribution and reads it back per client', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['notion', ['claude-code']], ['node_repl', ['codex']]]),
      new Set<ClientId>(['claude-code', 'codex']));
    const m = store.serversByClient();
    expect([...m.get('claude-code')!]).toEqual(['notion']);
    expect([...m.get('codex')!]).toEqual(['node_repl']);
  });

  it('maps one server to several clients', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['deepwiki', ['claude-code', 'codex']]]),
      new Set<ClientId>(['claude-code', 'codex']));
    const m = store.serversByClient();
    expect(m.get('claude-code')!.has('deepwiki')).toBe(true);
    expect(m.get('codex')!.has('deepwiki')).toBe(true);
  });

  it('drops a server removed from the config for a replaceable client', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['old', ['claude-code']], ['keep', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));
    store.upsertClientServers(
      attr([['keep', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));
    expect([...store.serversByClient().get('claude-code')!]).toEqual(['keep']);
  });

  it('preserves the existing mapping for a client that is not replaceable', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['notion', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));
    // A read error dropped claude-code from replaceable
    store.upsertClientServers(new Map(), new Set<ClientId>());
    expect([...store.serversByClient().get('claude-code')!]).toEqual(['notion']);
  });

  // Dying after the DELETE and before the INSERT completes would leave that client's attribution empty.
  // In one transaction, a failure must leave the previous state intact.
  it('leaves the existing attribution intact when it fails midway', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['notion', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));

    // Make the last step of the upsert (retroactive attribution of codex loads) blow up
    const spy = vi.spyOn(store as never as { reattributePendingCodexLoads: () => void },
      'reattributePendingCodexLoads').mockImplementation(() => { throw new Error('boom'); });
    expect(() => store.upsertClientServers(
      attr([['other', ['claude-code']]]),
      new Set<ClientId>(['claude-code']))).toThrow('boom');
    spy.mockRestore();

    expect([...store.serversByClient().get('claude-code')!]).toEqual(['notion']);
  });

  it('empties the mapping of a replaceable client with 0 servers', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['x', ['gemini-cli']]]),
      new Set<ClientId>(['gemini-cli']));
    store.upsertClientServers(new Map(), new Set<ClientId>(['gemini-cli']));
    expect(store.serversByClient().has('gemini-cli')).toBe(false);
  });

  // C1 boundary test: testing store and engine separately cannot catch this defect.
  // It verifies across both layers that passing the serversByClient() result of an empty DB
  // (an empty Map) straight into splitByClient does not filter out every definition.
  it('keeps definitions alive when the serversByClient() result of an empty DB goes straight into splitByClient', async () => {
    const store = await LensStore.open(':memory:');
    const definitions = [
      { serverName: 'notion', toolName: 'search', definitionTokens: 100,
        scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' },
    ];
    const sessions = [
      { sessionId: 'c1', client: 'claude-code' as ClientId, filePath: '/f',
        externalSessionId: null, startedAt: '2026-07-10T00:00:00Z', mode: 'UPFRONT' as const },
    ];
    const parts = splitByClient({
      definitions, calls: [], loads: [], sessions,
      serversByClient: store.serversByClient(), // empty DB gives an empty Map (size 0), not undefined
    });
    const claude = parts.find((p) => p.client === 'claude-code')!;
    expect(claude.input.definitions).toHaveLength(1);
  });
});
