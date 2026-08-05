import { describe, it, expect, vi } from 'vitest';
import { WriterLeaseManager } from '../src/writerLease.js';

function fakeDeps(over: any = {}) {
  return {
    acquire: vi.fn(() => ({ token: 't1', expiresAt: 1 })),
    renew: vi.fn(() => ({ token: 't1', expiresAt: 2 })),
    release: vi.fn(),
    setInterval: vi.fn(() => 1 as any),
    clearInterval: vi.fn(),
    ...over,
  };
}

describe('WriterLeaseManager', () => {
  it('is the holder when acquire succeeds', () => {
    const m = new WriterLeaseManager('/lock', { deps: fakeDeps() } as any);
    expect(m.tryAcquire()).toBe(true);
    expect(m.isHolder()).toBe(true);
  });

  it('is a non-holder when acquire fails', () => {
    const m = new WriterLeaseManager('/lock', { deps: fakeDeps({ acquire: vi.fn(() => null) }) } as any);
    expect(m.tryAcquire()).toBe(false);
    expect(m.isHolder()).toBe(false);
  });

  it('drops holder status and calls onLost when renew returns null', () => {
    let tick: () => void = () => {};
    const deps = fakeDeps({
      renew: vi.fn(() => null),
      setInterval: vi.fn((fn: () => void) => { tick = fn; return 1 as any; }),
    });
    const m = new WriterLeaseManager('/lock', { deps } as any);
    m.tryAcquire();
    const onLost = vi.fn();
    m.startHeartbeat(onLost);
    tick(); // one heartbeat, renew=null
    expect(m.isHolder()).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
  });

  it('drops holder status and calls onLost even when renew throws (split-brain guard)', () => {
    let tick: () => void = () => {};
    const deps = fakeDeps({
      renew: vi.fn(() => { const e: any = new Error('EACCES'); e.code = 'EACCES'; throw e; }),
      setInterval: vi.fn((fn: () => void) => { tick = fn; return 1 as any; }),
    });
    const m = new WriterLeaseManager('/lock', { deps } as any);
    m.tryAcquire();
    const onLost = vi.fn();
    m.startHeartbeat(onLost);
    expect(() => tick()).not.toThrow(); // no exception may escape the interval callback
    expect(m.isHolder()).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
    expect(deps.clearInterval).toHaveBeenCalled();
  });
});
