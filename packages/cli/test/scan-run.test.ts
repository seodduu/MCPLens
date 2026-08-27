import { describe, it, expect, vi } from 'vitest';
import { scanOneServer } from '../src/scan-run.js';
import type { LensStore, McpServerSpec, ServerIdentity, scanServer } from '@mcp-lens/core';

type ScanResult = Awaited<ReturnType<typeof scanServer>>;

/**
 * Pins, at this unit, that one server's failure inside the `mcp-lens scan` loop cannot wipe out
 * the other servers' records and the final store.save().
 * runScan itself (the for loop, the --config branch, console output) is out of scope here.
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
  it('records ok on success', async () => {
    const { store, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => ({
      definitions: [{ definitionTokens: 10 }, { definitionTokens: 5 }],
      bodies: [],
    } as unknown as ScanResult));

    const result = await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.recordServerScanStatus).toHaveBeenCalledWith('srv', 'ok', '2026-08-05T00:00:00.000Z');
    expect(result).toEqual({ ok: true, toolCount: 2, totalTokens: 15 });
  });

  // T4: scanServer's overhead must reach store.upsertScanResult, otherwise a rescan never
  // updates server_context_overheads and the report keeps using stale (or missing) instructions
  // tokens for that server.
  it('passes the scan overhead through to store.upsertScanResult', async () => {
    const { store, mocks } = fakeStore();
    const overhead = {
      serverName: 'srv', instructionsTokens: 42, instructionsSha256: 'a'.repeat(64),
      estimatorVersion: 'v2-2026-08-27', scannedAt: '2026-08-05T00:00:00.000Z',
    };
    const scan = vi.fn(async (): Promise<ScanResult> => ({
      definitions: [{ definitionTokens: 10 }],
      bodies: [],
      overhead,
    } as unknown as ScanResult));

    await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.upsertScanResult).toHaveBeenCalledWith(
      [{ definitionTokens: 10 }], [], [], overhead);
  });

  it('records auth-required exceptions as auth-required', async () => {
    const { store, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw new Error('auth-required: 401');
    });

    const result = await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.recordServerScanStatus)
      .toHaveBeenCalledWith('srv', 'auth-required', '2026-08-05T00:00:00.000Z', undefined);
    expect(result.ok).toBe(false);
  });

  it('records other exceptions as failed with an errorCode', async () => {
    const { store, mocks } = fakeStore();
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw new Error('spawn ENOENT');
    });

    await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);

    expect(mocks.recordServerScanStatus)
      .toHaveBeenCalledWith('srv', 'failed', '2026-08-05T00:00:00.000Z', 'spawn ENOENT');
  });

  it('never throws to the caller, even on an exception', async () => {
    const { store } = fakeStore();
    // Even a non-Error exception (a string) is swallowed by scanOneServer so the rest of the
    // loop and the final store.save() still run.
    const scan = vi.fn(async (): Promise<ScanResult> => {
      throw 'network down';
    });

    // If the await itself rejected, this test would fail here, so a normal return is the proof
    // that scanOneServer swallowed the exception.
    const result = await scanOneServer(store, spec, '2026-08-05T00:00:00.000Z', identities, scan);
    expect(result.ok).toBe(false);
  });
});
