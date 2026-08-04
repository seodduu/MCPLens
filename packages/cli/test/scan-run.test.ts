import { describe, it, expect, vi } from 'vitest';
import { scanOneServer } from '../src/scan-run.js';
import type { LensStore, McpServerSpec, ServerIdentity, scanServer } from '@mcp-lens/core';

type ScanResult = Awaited<ReturnType<typeof scanServer>>;

/**
 * `mcp-lens scan` 루프가 서버 여러 개를 도는 동안, 한 서버의 실패가 나머지 서버의
 * 기록과 마지막 store.save()를 통째로 날리지 않는지 이 단위에서 고정한다.
 * runScan 자체(for 루프, --config 분기, 콘솔 출력)는 이 태스크 범위 밖이다.
 */
function fakeStore() {
  const store = {
    upsertScanResult: vi.fn(),
    recordServerScanStatus: vi.fn(),
  };
  return { store: store as unknown as LensStore, mocks: store };
}

const spec: McpServerSpec = { name: 'srv', type: 'http', url: 'https://example.com' } as McpServerSpec;
const identities: ServerIdentity[] = [];

describe('scanOneServer', () => {
  it('성공 시 ok로 기록된다', async () => {
    const { store, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => ({
      definitions: [{ definitionTokens: 10 }, { definitionTokens: 5 }],
      bodies: [],
    } as unknown as ScanResult));

    const result = await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.recordServerScanStatus).toHaveBeenCalledWith('srv', 'ok', '2026-08-05T00:00:00.000Z');
    expect(result).toEqual({ ok: true, toolCount: 2, totalTokens: 15 });
  });

  it('auth-required 예외는 auth-required로 기록된다', async () => {
    const { store, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw new Error('auth-required: 401');
    });

    const result = await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.recordServerScanStatus)
      .toHaveBeenCalledWith('srv', 'auth-required', '2026-08-05T00:00:00.000Z', undefined);
    expect(result.ok).toBe(false);
  });

  it('그 외 예외는 failed와 errorCode로 기록된다', async () => {
    const { store, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw new Error('spawn ENOENT');
    });

    await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.recordServerScanStatus)
      .toHaveBeenCalledWith('srv', 'failed', '2026-08-05T00:00:00.000Z', 'spawn ENOENT');
  });

  it('예외가 나도 호출자에게 던지지 않는다', async () => {
    const { store } = fakeStore();
    // 비Error 예외(문자열)를 던져도 scanOneServer가 삼켜서, 이 서버 이후의 루프와
    // 마지막 store.save()가 실행될 수 있게 한다.
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw 'network down';
    });

    // await 자체가 reject되면 여기서 테스트가 실패하므로, 정상 반환됐다는 사실이 곧
    // scanOneServer가 예외를 삼켰다는 증거다.
    const result = await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);
    expect(result.ok).toBe(false);
  });
});
