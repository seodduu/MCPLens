import { describe, expect, it } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import type { AdapterResult, ClientId, ToolDefinition } from '../../src/types.js';

const NOW = '2026-08-05T00:00:00.000Z';
const SINCE = '2000-01-01';

const definition = (serverName: string, toolName: string): ToolDefinition => ({
  serverName, toolName, definitionTokens: 100, scannedAt: NOW, firstScannedAt: NOW,
});

/** A collection result holding only the given calls, in one session of the given client. */
function session(
  client: ClientId,
  calls: readonly { serverName: string; toolName: string }[],
): AdapterResult {
  const sessionId = `${client}-call-session`;
  return {
    session: {
      sessionId, client, filePath: `/tmp/${client}-call.jsonl`,
      externalSessionId: `${client}-call-external`, startedAt: NOW,
      mode: client === 'codex' ? 'DEFERRED_MEASURABLE' : 'UPFRONT',
    },
    toolCalls: calls.map((call) => ({
      sessionId, ...call, calledAt: NOW, durationMs: 12, isError: false,
      responseTokens: 30, responseText: null,
    })),
    toolLoads: [],
    usage: [], parseErrors: 0,
  };
}

/** Registers the servers as configured for codex. This is separate from a definition scan. */
function registerCodexServers(store: LensStore, servers: readonly string[]): void {
  store.upsertClientServers(
    new Map(servers.map((name) => [name, new Set<ClientId>(['codex'])])),
    new Set<ClientId>(['codex']),
  );
}

const namesOf = (store: LensStore): string[] => store.callsSince(SINCE).map((c) => c.toolName);

describe('codex tool name canonicalization', () => {
  it('restores the tool name a dash was replaced in', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['notion']);
    store.upsertScanResult([definition('notion', 'notion-search')], [], []);

    store.ingest(session('codex', [{ serverName: 'notion', toolName: 'notion_search' }]));

    expect(namesOf(store)).toEqual(['notion-search']);
  });

  it('leaves an already canonical name alone', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['lenstest']);
    store.upsertScanResult([definition('lenstest', 'get_weather')], [], []);

    store.ingest(session('codex', [{ serverName: 'lenstest', toolName: 'get_weather' }]));

    expect(namesOf(store)).toEqual(['get_weather']);
  });

  it('leaves the name alone when two definitions sanitize to the same string', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['amb']);
    store.upsertScanResult([definition('amb', 'a-b'), definition('amb', 'a_b')], [], []);

    store.ingest(session('codex', [{ serverName: 'amb', toolName: 'a_b' }]));

    expect(namesOf(store)).toEqual(['a_b']);
  });

  it('leaves the name alone when the sanitized match is ambiguous and neither is canonical', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['amb']);
    store.upsertScanResult([definition('amb', 'a-b'), definition('amb', 'a.b')], [], []);

    store.ingest(session('codex', [{ serverName: 'amb', toolName: 'a_b' }]));

    expect(namesOf(store)).toEqual(['a_b']);
  });

  it('leaves the name alone when the server was never scanned', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['ghost']);

    store.ingest(session('codex', [{ serverName: 'ghost', toolName: 'x_y' }]));

    expect(namesOf(store)).toEqual(['x_y']);
  });

  it('does not touch a claude-code session', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertScanResult([definition('notion', 'notion-search')], [], []);

    store.ingest(session('claude-code', [{ serverName: 'notion', toolName: 'notion_search' }]));

    expect(namesOf(store)).toEqual(['notion_search']);
  });

  it('rebuilds an already stored session once the definitions arrive', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['notion']);
    store.ingest(session('codex', [{ serverName: 'notion', toolName: 'notion_search' }]));
    expect(namesOf(store)).toEqual(['notion_search']);

    store.upsertScanResult([definition('notion', 'notion-search')], [], []);

    expect(namesOf(store)).toEqual(['notion-search']);
  });
});
