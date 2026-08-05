import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, renewLease, releaseLease, readLease, takeOverLease, installLease, sweepReapingDirs } from '../../src/ingest/lease.js';

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

  it('split-brain: check와 write 사이 인수당하면 renew는 null이고 B의 정체성을 오염시키지 않는다', () => {
    let t = 1000; const now = () => t;
    const a = acquireLease(lock, 1000, now)!;
    // check(readLease) 직후·write 직전에 경쟁자 B의 완전한 인수를 끼워넣는다.
    let ran = false;
    const r = renewLease(lock, a.token, 1000, now, {
      beforeWrite: () => {
        ran = true;
        expect(takeOverLease(lock, a.token)).toBe(true);
        expect(installLease(lock, { token: 'B', expiresAt: 9999 })).toBe(true);
      },
    });
    expect(ran).toBe(true);
    // 단언 1: A는 졌다.
    expect(r).toBeNull();
    // 단언 2: B의 정체성 토큰은 오염되지 않았다 (둘 다 홀더면 여기서 실패).
    const after = readLease(lock)!;
    expect(after.token).toBe('B');
    // 단언 3: B의 만료도 A가 넣은 값으로 오염되지 않았다.
    expect(after.expiresAt).toBe(9999);
  });

  it('release 후 재획득 가능', () => {
    const a = acquireLease(lock, 1000)!;
    releaseLease(lock, a.token);
    expect(readLease(lock)).toBeNull();
    expect(acquireLease(lock, 1000)).not.toBeNull();
  });

  it('release는 reaping 잔해를 남기지 않는다', () => {
    const a = acquireLease(lock, 1000)!;
    releaseLease(lock, a.token);
    expect(readdirSync(dir).filter((name) => name.includes('.reaping-'))).toEqual([]);
  });

  // reaping 이름은 rename 이후에만 생기므로 활성 리스가 아니다. 남아 있으면 잔해다.
  it('sweepReapingDirs는 잔해만 지우고 살아 있는 락과 다른 파일은 건드리지 않는다', () => {
    const a = acquireLease(lock, 1000)!;
    mkdirSync(`${lock}.reaping-dead1`, { recursive: true });
    mkdirSync(`${lock}.reaping-dead2`, { recursive: true });
    writeFileSync(join(dir, 'keep.json'), '{}');
    expect(sweepReapingDirs(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['keep.json', 'w.lock']);
    expect(readLease(lock)?.token).toBe(a.token);
  });

  it('획득 시 이전 실행이 남긴 잔해를 함께 치운다', () => {
    mkdirSync(`${lock}.reaping-crashed`, { recursive: true });
    expect(acquireLease(lock, 1000)).not.toBeNull();
    expect(readdirSync(dir).filter((name) => name.includes('.reaping-'))).toEqual([]);
  });
});
