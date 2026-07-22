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
  it('acquire 성공 시 holder', () => {
    const m = new WriterLeaseManager('/lock', { deps: fakeDeps() } as any);
    expect(m.tryAcquire()).toBe(true);
    expect(m.isHolder()).toBe(true);
  });

  it('acquire 실패 시 non-holder', () => {
    const m = new WriterLeaseManager('/lock', { deps: fakeDeps({ acquire: vi.fn(() => null) }) } as any);
    expect(m.tryAcquire()).toBe(false);
    expect(m.isHolder()).toBe(false);
  });

  it('renew가 null이면 holder 해제 + onLost 호출', () => {
    let tick: () => void = () => {};
    const deps = fakeDeps({
      renew: vi.fn(() => null),
      setInterval: vi.fn((fn: () => void) => { tick = fn; return 1 as any; }),
    });
    const m = new WriterLeaseManager('/lock', { deps } as any);
    m.tryAcquire();
    const onLost = vi.fn();
    m.startHeartbeat(onLost);
    tick(); // 하트비트 1회 — renew=null
    expect(m.isHolder()).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
  });
});
