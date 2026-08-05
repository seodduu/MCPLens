import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, releaseLease, type Lease } from '@mcp-lens/core';
import { acquireWriterLease, withWriterLease, LEASE_BUSY_MESSAGE, type WriterLeaseDeps } from '../src/writer-lease.js';

/**
 * Pins that the CLI contends for the same lock as the extension and always releases the lease,
 * whatever path it exits through. The real filesystem and shared DB stay untouched; core's
 * acquire/renew/release are injected.
 */
function fakeDeps(overrides: Partial<WriterLeaseDeps> = {}) {
  const timers: Array<() => void> = [];
  const deps = {
    acquire: vi.fn((): Lease | null => ({ token: 't1', expiresAt: 1 })),
    renew: vi.fn((_p: string, token: string): Lease | null => ({ token, expiresAt: 2 })),
    release: vi.fn(),
    setInterval: vi.fn((fn: () => void) => { timers.push(fn); return timers.length - 1; }),
    clearInterval: vi.fn(),
    ensureDir: vi.fn(),
    lockPath: () => '/fake/.mcplens/db-writer.lock',
    ttlMs: 30_000,
    renewMs: 10_000,
    ...overrides,
  };
  return { deps, timers, tick: () => timers.forEach((fn) => fn()) };
}

describe('acquireWriterLease', () => {
  it('creates the lock directory first and takes the lease on the extension lock path', () => {
    const { deps } = fakeDeps();
    const result = acquireWriterLease(deps);

    expect(result.ok).toBe(true);
    expect(deps.ensureDir).toHaveBeenCalledWith('/fake/.mcplens');
    expect(deps.acquire).toHaveBeenCalledWith('/fake/.mcplens/db-writer.lock', 30_000);
  });

  it('fails with an actionable message when another holder is alive', () => {
    const { deps } = fakeDeps({ acquire: vi.fn(() => null) });
    const result = acquireWriterLease(deps);

    expect(result).toEqual({ ok: false, message: LEASE_BUSY_MESSAGE });
    expect(LEASE_BUSY_MESSAGE).toContain('extension');
  });

  it('releases with my own token and stops the heartbeat', () => {
    const { deps } = fakeDeps();
    const result = acquireWriterLease(deps);
    if (!result.ok) throw new Error('should have acquired the lease');

    expect(result.lease.isHolder()).toBe(true);
    result.lease.release();

    expect(deps.release).toHaveBeenCalledWith('/fake/.mcplens/db-writer.lock', 't1');
    expect(deps.clearInterval).toHaveBeenCalled();
    expect(result.lease.isHolder()).toBe(false);
  });

  it('releases only once even when release is called twice', () => {
    const { deps } = fakeDeps();
    const result = acquireWriterLease(deps);
    if (!result.ok) throw new Error('should have acquired the lease');

    result.lease.release();
    result.lease.release();

    expect(deps.release).toHaveBeenCalledTimes(1);
  });

  it('becomes a non-holder immediately when heartbeat renewal fails (taken over)', () => {
    const { deps, tick } = fakeDeps({ renew: vi.fn(() => null) });
    const result = acquireWriterLease(deps);
    if (!result.ok) throw new Error('should have acquired the lease');

    expect(result.lease.isHolder()).toBe(true);
    tick();
    expect(result.lease.isHolder()).toBe(false);
  });
});

describe('withWriterLease', () => {
  it('takes the lease before the body and releases it after', async () => {
    const { deps } = fakeDeps();
    const order: string[] = [];
    deps.release = vi.fn(() => { order.push('release'); });

    const result = await withWriterLease(async () => { order.push('body'); return 7; }, deps);

    expect(result).toEqual({ ok: true, value: 7 });
    expect(order).toEqual(['body', 'release']);
  });

  it('releases the lease even when the body throws', async () => {
    const { deps } = fakeDeps();
    await expect(withWriterLease(async () => { throw new Error('boom'); }, deps)).rejects.toThrow('boom');
    expect(deps.release).toHaveBeenCalledWith('/fake/.mcplens/db-writer.lock', 't1');
  });

  it('never runs the body when acquisition fails', async () => {
    const { deps } = fakeDeps({ acquire: vi.fn(() => null) });
    const body = vi.fn(async () => 1);

    const result = await withWriterLease(body, deps);

    expect(result.ok).toBe(false);
    expect(body).not.toHaveBeenCalled();
  });
});

/**
 * Checks the interlock with core's real lease implementation. It reproduces "the extension is
 * the holder" with acquireLease on the same lock path and verifies the CLI cannot take it.
 * The shared DB (~/.mcplens/lens.db) is untouched; only a lock file in a temp directory is used.
 */
describe('real interaction with the core lease', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function tempLock(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcplens-cli-lease-'));
    dirs.push(dir);
    return join(dir, 'db-writer.lock');
  }

  it('cannot take the lease while another holder (the extension) is alive', () => {
    const lockPath = tempLock();
    const holder = acquireLease(lockPath, 30_000) as Lease;
    expect(holder).not.toBeNull();

    const result = acquireWriterLease({ lockPath: () => lockPath });

    expect(result.ok).toBe(false);
    releaseLease(lockPath, holder.token);
  });

  it('takes the lease once the holder releases, and frees it for the next run', () => {
    const lockPath = tempLock();
    const first = acquireWriterLease({ lockPath: () => lockPath });
    if (!first.ok) throw new Error('the first run should have acquired it');
    expect(acquireLease(lockPath, 30_000)).toBeNull(); // meanwhile the extension cannot take it

    first.lease.release();

    const second = acquireWriterLease({ lockPath: () => lockPath });
    expect(second.ok).toBe(true);
    if (second.ok) second.lease.release();
  });
});
