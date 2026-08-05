import { describe, it, expect, vi } from 'vitest';
import { runAuthRescan } from '../src/auth-rescan.js';
import type { LensStore, McpServerSpec, scanServer } from '@mcp-lens/core';

type ScanResult = Awaited<ReturnType<typeof scanServer>>;

/**
 * From code review: when runAuth's rescan failed, whatever recordServerScanStatus wrote was
 * close()d without store.save() and never reached disk. This test pins that save is called
 * exactly once, before close, on both the success and failure paths.
 * What it does not pin: using the real dbPath(), main() command routing, console output format.
 * Those need runAuth driven end-to-end and are out of scope here.
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
  it('calls save once before close when the scan succeeds', async () => {
    const { store, calls, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => ({
      definitions: [], bodies: [],
    } as unknown as ScanResult));

    await runAuthRescan(store, spec, '2026-08-05T00:00:00.000Z', scan);

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('save')).toBeLessThan(calls.indexOf('close'));
    expect(mocks.recordServerScanStatus).toHaveBeenCalledWith('srv', 'ok', '2026-08-05T00:00:00.000Z');
  });

  it('calls save once before close even when the scan fails (regression: missing save on failure)', async () => {
    const { store, calls, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw new Error('auth-required: 401');
    });

    await runAuthRescan(store, spec, '2026-08-05T00:00:00.000Z', scan);

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('save')).toBeLessThan(calls.indexOf('close'));
    expect(mocks.recordServerScanStatus)
      .toHaveBeenCalledWith('srv', 'auth-required', '2026-08-05T00:00:00.000Z', undefined);
  });
});
