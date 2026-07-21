import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, renewLease, releaseLease, readLease } from '../../src/ingest/lease.js';

let dir: string; let lock: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lease-')); lock = join(dir, 'w.lock'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lease', () => {
  it('한 번에 하나만 획득한다', () => {
    const a = acquireLease(lock, 1000);
    expect(a).not.toBeNull();
    expect(acquireLease(lock, 1000)).toBeNull(); // 이미 유효한 홀더
  });

  it('renew는 만료를 연장하고 같은 토큰을 유지한다', () => {
    let t = 1000;
    const now = () => t;
    const a = acquireLease(lock, 1000, now)!;
    t = 1500;
    const r = renewLease(lock, a.token, 1000, now)!;
    expect(r.token).toBe(a.token);
    expect(r.expiresAt).toBe(2500); // 1500 + 1000
  });

  it('인수당한 뒤 renew는 null', () => {
    let t = 1000; const now = () => t;
    const a = acquireLease(lock, 1000, now)!;
    t = 3000; // a 만료
    const b = acquireLease(lock, 1000, now)!; // b가 인수
    expect(b.token).not.toBe(a.token);
    expect(renewLease(lock, a.token, 1000, now)).toBeNull(); // a는 잃음
  });

  it('만료된 리스는 다른 프로세스가 인수한다', () => {
    let t = 1000; const now = () => t;
    acquireLease(lock, 1000, now);
    t = 5000;
    const b = acquireLease(lock, 1000, now);
    expect(b).not.toBeNull();
  });

  it('release 후 재획득 가능', () => {
    const a = acquireLease(lock, 1000)!;
    releaseLease(lock, a.token);
    expect(readLease(lock)).toBeNull();
    expect(acquireLease(lock, 1000)).not.toBeNull();
  });
});
