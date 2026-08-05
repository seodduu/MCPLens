// packages/core/test/store/clientServers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import { splitByClient } from '../../src/engine/engine.js';
import type { ClientId } from '../../src/types.js';

const attr = (pairs: Array<[string, ClientId[]]>) =>
  new Map(pairs.map(([name, clients]) => [name, new Set(clients)]));

describe('client_servers', () => {
  it('빈 DB에서는 빈 맵을 돌려준다', async () => {
    const store = await LensStore.open(':memory:');
    expect(store.serversByClient().size).toBe(0);
  });

  it('귀속을 저장하고 클라이언트별로 되읽는다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['notion', ['claude-code']], ['node_repl', ['codex']]]),
      new Set<ClientId>(['claude-code', 'codex']));
    const m = store.serversByClient();
    expect([...m.get('claude-code')!]).toEqual(['notion']);
    expect([...m.get('codex')!]).toEqual(['node_repl']);
  });

  it('한 서버가 여러 클라이언트에 매핑된다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['deepwiki', ['claude-code', 'codex']]]),
      new Set<ClientId>(['claude-code', 'codex']));
    const m = store.serversByClient();
    expect(m.get('claude-code')!.has('deepwiki')).toBe(true);
    expect(m.get('codex')!.has('deepwiki')).toBe(true);
  });

  it('교체 가능한 클라이언트는 설정에서 사라진 서버가 매핑에서 빠진다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['old', ['claude-code']], ['keep', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));
    store.upsertClientServers(
      attr([['keep', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));
    expect([...store.serversByClient().get('claude-code')!]).toEqual(['keep']);
  });

  it('교체 대상이 아닌 클라이언트는 기존 매핑을 보존한다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['notion', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));
    // 읽기 오류로 claude-code가 replaceable에서 빠진 상황
    store.upsertClientServers(new Map(), new Set<ClientId>());
    expect([...store.serversByClient().get('claude-code')!]).toEqual(['notion']);
  });

  // DELETE 이후·INSERT 완료 이전에 죽으면 그 클라이언트의 귀속이 빈 채로 남는다.
  // 한 트랜잭션이면 실패해도 직전 상태가 그대로 살아 있어야 한다.
  it('중간에 실패하면 기존 귀속이 그대로 남는다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['notion', ['claude-code']]]),
      new Set<ClientId>(['claude-code']));

    // upsert 마지막 단계(코덱스 load 소급 귀속)에서 터지는 상황을 만든다
    const spy = vi.spyOn(store as never as { reattributePendingCodexLoads: () => void },
      'reattributePendingCodexLoads').mockImplementation(() => { throw new Error('boom'); });
    expect(() => store.upsertClientServers(
      attr([['other', ['claude-code']]]),
      new Set<ClientId>(['claude-code']))).toThrow('boom');
    spy.mockRestore();

    expect([...store.serversByClient().get('claude-code')!]).toEqual(['notion']);
  });

  it('교체 가능한데 서버가 0개면 그 클라이언트 매핑이 비워진다', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertClientServers(
      attr([['x', ['gemini-cli']]]),
      new Set<ClientId>(['gemini-cli']));
    store.upsertClientServers(new Map(), new Set<ClientId>(['gemini-cli']));
    expect(store.serversByClient().has('gemini-cli')).toBe(false);
  });

  // C1 경계 테스트: store와 engine을 각각 테스트해서는 이 결함을 못 잡는다 —
  // 빈 DB의 serversByClient() 결과(빈 Map)를 그대로 splitByClient에 넘겼을 때
  // 정의가 전량 필터링되지 않는지를 두 계층에 걸쳐 검증한다.
  it('빈 DB의 serversByClient() 결과를 splitByClient에 그대로 넘겨도 정의가 살아남는다', async () => {
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
      serversByClient: store.serversByClient(), // 빈 DB → 빈 Map (size 0), undefined 아님
    });
    const claude = parts.find((p) => p.client === 'claude-code')!;
    expect(claude.input.definitions).toHaveLength(1);
  });
});
