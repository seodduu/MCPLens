import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, releaseLease, type Lease } from '@mcp-lens/core';
import { acquireWriterLease, withWriterLease, LEASE_BUSY_MESSAGE, type WriterLeaseDeps } from '../src/writer-lease.js';

/**
 * CLI가 확장과 같은 락을 두고 경쟁하는지, 그리고 어떤 경로로 끝나도 리스를 놓는지 고정한다.
 * 실제 파일시스템·공유 DB는 건드리지 않고 core의 acquire/renew/release를 주입한다.
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
  it('락 디렉터리를 먼저 만들고 확장과 같은 락 경로로 리스를 잡는다', () => {
    const { deps } = fakeDeps();
    const result = acquireWriterLease(deps);

    expect(result.ok).toBe(true);
    expect(deps.ensureDir).toHaveBeenCalledWith('/fake/.mcplens');
    expect(deps.acquire).toHaveBeenCalledWith('/fake/.mcplens/db-writer.lock', 30_000);
  });

  it('다른 홀더가 살아 있으면 조치 가능한 한국어 메시지로 실패한다', () => {
    const { deps } = fakeDeps({ acquire: vi.fn(() => null) });
    const result = acquireWriterLease(deps);

    expect(result).toEqual({ ok: false, message: LEASE_BUSY_MESSAGE });
    expect(LEASE_BUSY_MESSAGE).toContain('확장');
  });

  it('release는 내 토큰으로 해제하고 하트비트를 멈춘다', () => {
    const { deps } = fakeDeps();
    const result = acquireWriterLease(deps);
    if (!result.ok) throw new Error('획득했어야 한다');

    expect(result.lease.isHolder()).toBe(true);
    result.lease.release();

    expect(deps.release).toHaveBeenCalledWith('/fake/.mcplens/db-writer.lock', 't1');
    expect(deps.clearInterval).toHaveBeenCalled();
    expect(result.lease.isHolder()).toBe(false);
  });

  it('release를 두 번 불러도 한 번만 해제한다', () => {
    const { deps } = fakeDeps();
    const result = acquireWriterLease(deps);
    if (!result.ok) throw new Error('획득했어야 한다');

    result.lease.release();
    result.lease.release();

    expect(deps.release).toHaveBeenCalledTimes(1);
  });

  it('하트비트 갱신에 실패하면(인수당함) 즉시 비홀더가 된다', () => {
    const { deps, tick } = fakeDeps({ renew: vi.fn(() => null) });
    const result = acquireWriterLease(deps);
    if (!result.ok) throw new Error('획득했어야 한다');

    expect(result.lease.isHolder()).toBe(true);
    tick();
    expect(result.lease.isHolder()).toBe(false);
  });
});

describe('withWriterLease', () => {
  it('본문 실행 전후로 잡고 놓는다', async () => {
    const { deps } = fakeDeps();
    const order: string[] = [];
    deps.release = vi.fn(() => { order.push('release'); });

    const result = await withWriterLease(async () => { order.push('body'); return 7; }, deps);

    expect(result).toEqual({ ok: true, value: 7 });
    expect(order).toEqual(['body', 'release']);
  });

  it('본문이 던져도 리스를 놓는다', async () => {
    const { deps } = fakeDeps();
    await expect(withWriterLease(async () => { throw new Error('boom'); }, deps)).rejects.toThrow('boom');
    expect(deps.release).toHaveBeenCalledWith('/fake/.mcplens/db-writer.lock', 't1');
  });

  it('획득 실패면 본문을 아예 실행하지 않는다', async () => {
    const { deps } = fakeDeps({ acquire: vi.fn(() => null) });
    const body = vi.fn(async () => 1);

    const result = await withWriterLease(body, deps);

    expect(result.ok).toBe(false);
    expect(body).not.toHaveBeenCalled();
  });
});

/**
 * core의 실제 리스 구현과 맞물리는지 확인한다. 확장이 홀더인 상황을 같은 락 경로에
 * acquireLease로 재현하고, CLI가 그 위에서 잡히지 않는지 본다.
 * 공유 DB(~/.mcplens/lens.db)는 건드리지 않고 임시 디렉터리의 락 파일만 쓴다.
 */
describe('core 리스와의 실제 상호작용', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function tempLock(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcplens-cli-lease-'));
    dirs.push(dir);
    return join(dir, 'db-writer.lock');
  }

  it('다른 홀더(확장)가 살아 있으면 CLI는 리스를 못 잡는다', () => {
    const lockPath = tempLock();
    const holder = acquireLease(lockPath, 30_000) as Lease;
    expect(holder).not.toBeNull();

    const result = acquireWriterLease({ lockPath: () => lockPath });

    expect(result.ok).toBe(false);
    releaseLease(lockPath, holder.token);
  });

  it('홀더가 놓으면 CLI가 잡고, CLI가 놓으면 다음 실행이 다시 잡는다', () => {
    const lockPath = tempLock();
    const first = acquireWriterLease({ lockPath: () => lockPath });
    if (!first.ok) throw new Error('첫 실행은 잡았어야 한다');
    expect(acquireLease(lockPath, 30_000)).toBeNull(); // 그 사이 확장은 못 잡는다

    first.lease.release();

    const second = acquireWriterLease({ lockPath: () => lockPath });
    expect(second.ok).toBe(true);
    if (second.ok) second.lease.release();
  });
});
