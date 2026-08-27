import { describe, expect, it } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import { buildMatrix } from '../../src/engine/engine.js';
import type { AdapterResult, ClientId, ToolDefinition, ToolLoadEvent } from '../../src/types.js';

const NOW = '2026-08-05T00:00:00.000Z';
const SINCE = '2000-01-01';

const definition = (serverName: string, toolName: string): ToolDefinition => ({
  serverName, toolName, definitionTokens: 100, advertisedTokens: null, estimatorVersion: 'v1',
  scannedAt: NOW, firstScannedAt: NOW,
});

/** A collection result holding only the given load, in one codex session. */
function codexSession(
  loads: readonly { serverName: string | null; toolName: string; loadedTokens: number | null }[],
): AdapterResult {
  const sessionId = 'codex-load-session';
  return {
    session: {
      sessionId, client: 'codex', filePath: '/tmp/codex-load.jsonl',
      externalSessionId: 'codex-load-external', startedAt: NOW, mode: 'DEFERRED_MEASURABLE',
    },
    toolCalls: [],
    toolLoads: loads.map((load) => ({ sessionId, ...load })),
    usage: [], parseErrors: 0,
  };
}

function claudeSession(): AdapterResult {
  const sessionId = 'claude-load-session';
  return {
    session: {
      sessionId, client: 'claude-code', filePath: '/tmp/claude-load.jsonl',
      externalSessionId: 'claude-load-external', startedAt: NOW, mode: 'UPFRONT',
    },
    toolCalls: [],
    toolLoads: [{ sessionId, serverName: 'notion', toolName: 'notion-search', loadedTokens: 12 }],
    usage: [], parseErrors: 0,
  };
}

/** Registers node_repl as a server configured for codex. This is separate from a definition scan. */
function registerCodexServers(store: LensStore, servers: readonly string[]): void {
  store.upsertClientServers(
    new Map(servers.map((name) => [name, new Set<ClientId>(['codex'])])),
    new Set<ClientId>(['codex']),
  );
}

const loadsOf = (store: LensStore): ToolLoadEvent[] => store.loadsSince(SINCE);

describe('codex load attribution', () => {
  it('attributes at collection time when the scan came first', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);
    registerCodexServers(store, ['node_repl']);

    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: 'node_repl',
      toolName: 'js_reset', loadedTokens: 37,
    }]);
  });

  it('leaves it null for now when the observation came first', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['node_repl']);

    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: null,
      toolName: 'mcp__node_repl__js_reset', loadedTokens: 37,
    }]);
  });

  it('recovers retroactively when the scan arrives later', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['node_repl']);
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));

    // Only the definition scan arrives; the log is never re-read.
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: 'node_repl',
      toolName: 'js_reset', loadedTokens: 37,
    }]);
  });

  it('gives the same result when the recovery pass runs twice', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['node_repl']);
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));

    store.upsertDefinitions([definition('node_repl', 'js_reset')]);
    const once = loadsOf(store);
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);
    const twice = loadsOf(store);

    expect(twice).toEqual(once);
    expect(twice).toHaveLength(1);
  });

  it('recovers retroactively from a client_servers update alone', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);
    // Collected in a state where attribution failed because client_servers did not exist yet.
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));
    expect(loadsOf(store)[0]).toMatchObject({ serverName: null });

    // Reproduces the path where scanning has settled and upsertDefinitions no longer runs.
    registerCodexServers(store, ['node_repl']);

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: 'node_repl',
      toolName: 'js_reset', loadedTokens: 37,
    }]);
  });

  it('keeps the client_servers recovery pass idempotent too', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));

    registerCodexServers(store, ['node_repl']);
    const once = loadsOf(store);
    registerCodexServers(store, ['node_repl']);
    const twice = loadsOf(store);

    expect(twice).toEqual(once);
    expect(twice).toHaveLength(1);
  });

  it('does not attribute when there are two or more candidates', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([
      definition('atlas', 'deep__lookup'),
      definition('atlas__deep', 'lookup'),
    ]);
    registerCodexServers(store, ['atlas', 'atlas__deep']);

    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__atlas__deep__lookup', loadedTokens: 21 },
    ]));

    expect(loadsOf(store)[0]).toMatchObject({
      serverName: null, toolName: 'mcp__atlas__deep__lookup',
    });
  });

  it('leaves loads of non-codex clients untouched', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(claudeSession());
    const before = loadsOf(store);

    store.upsertDefinitions([definition('notion', 'notion-search')]);

    expect(loadsOf(store)).toEqual(before);
    expect(before).toEqual([{
      sessionId: 'claude-load-session', serverName: 'notion',
      toolName: 'notion-search', loadedTokens: 12,
    }]);
  });

  it('excludes the (code-mode-search) aggregate row from attribution', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['node_repl']);
    store.ingest(codexSession([
      { serverName: null, toolName: '(code-mode-search)', loadedTokens: 480 },
    ]));

    store.upsertDefinitions([definition('node_repl', '(code-mode-search)')]);

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: null,
      toolName: '(code-mode-search)', loadedTokens: 480,
    }]);
  });

  it('attributes a load whose tool name had a dash replaced', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('notion', 'notion-search')]);
    registerCodexServers(store, ['notion']);

    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__notion__notion_search', loadedTokens: 52 },
    ]));

    expect(loadsOf(store)[0]).toMatchObject({
      serverName: 'notion', toolName: 'notion-search',
    });
  });

  it('attributes a load when the server name itself had a dash replaced', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('brave-search', 'brave_web_search')]);
    registerCodexServers(store, ['brave-search']);

    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__brave_search__brave_web_search', loadedTokens: 44 },
    ]));

    expect(loadsOf(store)[0]).toMatchObject({
      serverName: 'brave-search', toolName: 'brave_web_search',
    });
  });

  it('leaves a load alone when two servers sanitize to the same joined name', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('a-b', 't'), definition('a_b', 't')]);
    registerCodexServers(store, ['a-b', 'a_b']);

    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__a_b__t', loadedTokens: 9 },
    ]));

    expect(loadsOf(store)[0]).toMatchObject({
      serverName: null, toolName: 'mcp__a_b__t',
    });
  });

  it('surfaces an attributed load as a matrix row', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['node_repl']);
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);

    const rows = buildMatrix({
      definitions: store.allDefinitions(),
      calls: store.callsSince(SINCE),
      loads: loadsOf(store),
      sessions: store.sessionsSince(SINCE),
    });
    const row = rows.find((r) => r.serverName === 'node_repl' && r.toolName === 'js_reset');

    expect(row).toBeDefined();
    expect(row!.loadedSessionCount).toBe(1);
    expect(row!.callCount).toBe(0);
  });
});
