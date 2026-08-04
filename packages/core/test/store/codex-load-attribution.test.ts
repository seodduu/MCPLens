import { describe, expect, it } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import { buildMatrix } from '../../src/engine/engine.js';
import type { AdapterResult, ClientId, ToolDefinition, ToolLoadEvent } from '../../src/types.js';

const NOW = '2026-08-05T00:00:00.000Z';
const SINCE = '2000-01-01';

const definition = (serverName: string, toolName: string): ToolDefinition => ({
  serverName, toolName, definitionTokens: 100, scannedAt: NOW, firstScannedAt: NOW,
});

/** codex 세션 하나에 주어진 load만 담은 수집 결과. */
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

/** codex에 node_repl 서버가 설정돼 있다고 등록한다. 정의 스캔과는 별개다. */
function registerCodexServers(store: LensStore, servers: readonly string[]): void {
  store.upsertClientServers(
    new Map(servers.map((name) => [name, new Set<ClientId>(['codex'])])),
    new Set<ClientId>(['codex']),
  );
}

const loadsOf = (store: LensStore): ToolLoadEvent[] => store.loadsSince(SINCE);

describe('codex load 귀속', () => {
  it('스캔이 먼저면 수집 시점에 귀속된다', async () => {
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

  it('관측이 먼저면 일단 null로 남는다', async () => {
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

  it('나중에 스캔이 들어오면 소급 회복된다', async () => {
    const store = await LensStore.open(':memory:');
    registerCodexServers(store, ['node_repl']);
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));

    // 로그를 다시 읽지 않고 정의 스캔만 들어온다.
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: 'node_repl',
      toolName: 'js_reset', loadedTokens: 37,
    }]);
  });

  it('회복 패스는 두 번 돌려도 결과가 같다', async () => {
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

  it('client_servers 갱신만으로도 소급 회복된다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition('node_repl', 'js_reset')]);
    // client_servers가 아직 없어 귀속에 실패한 상태로 수집된다.
    store.ingest(codexSession([
      { serverName: null, toolName: 'mcp__node_repl__js_reset', loadedTokens: 37 },
    ]));
    expect(loadsOf(store)[0]).toMatchObject({ serverName: null });

    // 스캔이 정착해 upsertDefinitions가 다시 돌지 않는 경로를 재현한다.
    registerCodexServers(store, ['node_repl']);

    expect(loadsOf(store)).toEqual([{
      sessionId: 'codex-load-session', serverName: 'node_repl',
      toolName: 'js_reset', loadedTokens: 37,
    }]);
  });

  it('client_servers 회복 패스도 멱등이다', async () => {
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

  it('후보가 2개 이상이면 귀속하지 않는다', async () => {
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

  it('codex가 아닌 클라이언트의 load는 건드리지 않는다', async () => {
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

  it('(code-mode-search) 집계 행은 귀속 대상이 아니다', async () => {
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

  it('귀속된 load는 매트릭스 행으로 나타난다', async () => {
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
