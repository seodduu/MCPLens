import { describe, it, expect } from 'vitest';
import { LensStore } from '../../src/store/store.js';

describe('server_scan_status', () => {
  it('keeps a server with no record out of the map', async () => {
    const store = await LensStore.open(':memory:');
    expect(store.serverScanStatuses().size).toBe(0);
    expect(store.serverScanStatuses().get('notion')).toBeUndefined();
  });

  it('overwrites by server_name in recordServerScanStatus', async () => {
    const store = await LensStore.open(':memory:');
    store.recordServerScanStatus('notion', 'failed', '2026-08-05T00:00:00.000Z', 'ECONN');
    store.recordServerScanStatus('notion', 'ok', '2026-08-05T01:00:00.000Z');
    const map = store.serverScanStatuses();
    expect(map.size).toBe(1);
    expect(map.get('notion')).toEqual({
      status: 'ok', scannedAt: '2026-08-05T01:00:00.000Z', errorCode: undefined });
  });

  it('stores auth-required even without an error_code', async () => {
    const store = await LensStore.open(':memory:');
    store.recordServerScanStatus('linear', 'auth-required', '2026-08-05T00:00:00.000Z');
    expect(store.serverScanStatuses().get('linear')?.status).toBe('auth-required');
  });

  it('queries each recorded server back by name', async () => {
    const store = await LensStore.open(':memory:');
    store.recordServerScanStatus('a', 'ok', '2026-08-05T00:00:00.000Z');
    store.recordServerScanStatus('b', 'auth-required', '2026-08-05T00:00:00.000Z');
    store.recordServerScanStatus('c', 'failed', '2026-08-05T00:00:00.000Z', 'ETIMEDOUT');
    const map = store.serverScanStatuses();
    expect(map.size).toBe(3);
    expect(map.get('c')?.errorCode).toBe('ETIMEDOUT');
  });
});
