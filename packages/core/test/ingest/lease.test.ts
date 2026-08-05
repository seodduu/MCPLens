import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, renewLease, releaseLease, readLease, takeOverLease, installLease, sweepReapingDirs } from '../../src/ingest/lease.js';

let dir: string; let lock: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lease-')); lock = join(dir, 'w.lock'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lease', () => {
  it('grants only one holder at a time', () => {
    const a = acquireLease(lock, 1000);
    expect(a).not.toBeNull();
    expect(acquireLease(lock, 1000)).toBeNull(); // there is already a valid holder
  });

  it('extends the expiry on renew and keeps the same token', () => {
    let t = 1000;
    const now = () => t;
    const a = acquireLease(lock, 1000, now)!;
    t = 1500;
    const r = renewLease(lock, a.token, 1000, now)!;
    expect(r.token).toBe(a.token);
    expect(r.expiresAt).toBe(2500); // 1500 + 1000
  });

  it('returns null from renew after being taken over', () => {
    let t = 1000; const now = () => t;
    const a = acquireLease(lock, 1000, now)!;
    t = 3000; // a expires
    const b = acquireLease(lock, 1000, now)!; // b takes over
    expect(b.token).not.toBe(a.token);
    expect(renewLease(lock, a.token, 1000, now)).toBeNull(); // a lost it
  });

  it('lets another process take over an expired lease', () => {
    let t = 1000; const now = () => t;
    acquireLease(lock, 1000, now);
    t = 5000;
    const b = acquireLease(lock, 1000, now);
    expect(b).not.toBeNull();
  });

  it('split-brain: a takeover between check and write makes renew null and does not corrupt B identity', () => {
    let t = 1000; const now = () => t;
    const a = acquireLease(lock, 1000, now)!;
    // A complete takeover by competitor B is injected right after check (readLease) and right before the write.
    let ran = false;
    const r = renewLease(lock, a.token, 1000, now, {
      beforeWrite: () => {
        ran = true;
        expect(takeOverLease(lock, a.token)).toBe(true);
        expect(installLease(lock, { token: 'B', expiresAt: 9999 })).toBe(true);
      },
    });
    expect(ran).toBe(true);
    // Assertion 1: A lost.
    expect(r).toBeNull();
    // Assertion 2: B's identity token is uncorrupted (this fails if both are holders).
    const after = readLease(lock)!;
    expect(after.token).toBe('B');
    // Assertion 3: B's expiry is not corrupted by the value A wrote either.
    expect(after.expiresAt).toBe(9999);
  });

  it('can be acquired again after release', () => {
    const a = acquireLease(lock, 1000)!;
    releaseLease(lock, a.token);
    expect(readLease(lock)).toBeNull();
    expect(acquireLease(lock, 1000)).not.toBeNull();
  });

  it('leaves no reaping debris on release', () => {
    const a = acquireLease(lock, 1000)!;
    releaseLease(lock, a.token);
    expect(readdirSync(dir).filter((name) => name.includes('.reaping-'))).toEqual([]);
  });

  // A reaping name only appears after a rename, so it is never an active lease. Anything left is debris.
  it('makes sweepReapingDirs delete only debris, leaving a live lock and other files alone', () => {
    const a = acquireLease(lock, 1000)!;
    mkdirSync(`${lock}.reaping-dead1`, { recursive: true });
    mkdirSync(`${lock}.reaping-dead2`, { recursive: true });
    writeFileSync(join(dir, 'keep.json'), '{}');
    expect(sweepReapingDirs(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['keep.json', 'w.lock']);
    expect(readLease(lock)?.token).toBe(a.token);
  });

  it('clears debris left by a previous run while acquiring', () => {
    mkdirSync(`${lock}.reaping-crashed`, { recursive: true });
    expect(acquireLease(lock, 1000)).not.toBeNull();
    expect(readdirSync(dir).filter((name) => name.includes('.reaping-'))).toEqual([]);
  });
});
