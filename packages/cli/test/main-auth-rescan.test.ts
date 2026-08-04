import { describe, it, expect, vi } from 'vitest';
import { runAuthRescan } from '../src/main.js';
import type { LensStore, McpServerSpec, scanServer } from '@mcp-lens/core';

type ScanResult = Awaited<ReturnType<typeof scanServer>>;

/**
 * 리뷰 지적 사항: runAuth의 재스캔이 실패하면 recordServerScanStatus로 기록한 값이
 * store.save() 없이 close()되어 디스크에 남지 않는 버그가 있었다. 이 테스트는
 * 성공/실패 두 경로 모두에서 save가 정확히 1번 호출되고, close보다 먼저 호출됨을 고정한다.
 * 이 테스트가 고정하지 않는 것: dbPath() 실경로 사용, main() 커맨드 라우팅,
 * console 출력 포맷 — 이들은 runAuth 자체를 end-to-end로 구동해야 검증되며
 * 이 태스크 범위에서는 다루지 않는다.
 */
function fakeStore() {
  const calls: string[] = [];
  const store = {
    upsertScanResult: vi.fn(() => calls.push('upsertScanResult')),
    recordServerScanStatus: vi.fn(() => calls.push('recordServerScanStatus')),
    save: vi.fn(() => calls.push('save')),
    close: vi.fn(() => calls.push('close')),
  };
  return { store: store as unknown as LensStore, calls, mocks: store };
}

const spec: McpServerSpec = { name: 'srv', type: 'http', url: 'https://example.com' } as McpServerSpec;

describe('runAuthRescan', () => {
  it('스캔이 성공하면 save가 close 이전에 1번 호출된다', async () => {
    const { store, calls, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => ({
      definitions: [], bodies: [],
    } as unknown as ScanResult));

    await runAuthRescan(store, spec, 'srv', '2026-08-05T00:00:00.000Z', scan);

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('save')).toBeLessThan(calls.indexOf('close'));
    expect(mocks.recordServerScanStatus).toHaveBeenCalledWith('srv', 'ok', '2026-08-05T00:00:00.000Z');
  });

  it('스캔이 실패해도 save가 close 이전에 1번 호출된다 (회귀: 실패 시 save 누락 버그)', async () => {
    const { store, calls, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw new Error('auth-required: 401');
    });

    await runAuthRescan(store, spec, 'srv', '2026-08-05T00:00:00.000Z', scan);

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('save')).toBeLessThan(calls.indexOf('close'));
    expect(mocks.recordServerScanStatus)
      .toHaveBeenCalledWith('srv', 'auth-required', '2026-08-05T00:00:00.000Z', undefined);
  });
});
