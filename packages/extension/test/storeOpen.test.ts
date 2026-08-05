import { describe, it, expect, vi } from 'vitest';
import { openStoreWithRecovery, corruptBackupPath, MEMORY_DB_PATH } from '../src/storeOpen.js';

const FIXED = new Date('2026-08-05T12:34:56.000Z');

function deps(over: Partial<Parameters<typeof openStoreWithRecovery<string>>[1]> = {}) {
  return {
    open: vi.fn(async () => 'store'),
    exists: vi.fn(() => true),
    rename: vi.fn(),
    now: () => FIXED,
    ...over,
  };
}

describe('corruptBackupPath', () => {
  it('adds a timestamp and strips colons that file names cannot hold', () => {
    expect(corruptBackupPath('/home/u/.mcplens/lens.db', FIXED))
      .toBe('/home/u/.mcplens/lens.db.corrupt-2026-08-05T12-34-56.000Z');
  });
});

describe('openStoreWithRecovery', () => {
  it('opens normally when nothing is wrong', async () => {
    const d = deps();
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('ok');
    expect(d.rename).not.toHaveBeenCalled();
  });

  it('backs up a corrupted DB and starts fresh with an empty one', async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('file is not a database'))
      .mockResolvedValueOnce('fresh');
    const d = deps({ open });
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('recovered');
    if (r.kind !== 'recovered') return;
    expect(r.store).toBe('fresh');
    expect(r.backupPath).toBe('/db/lens.db.corrupt-2026-08-05T12-34-56.000Z');
    expect(d.rename).toHaveBeenCalledWith('/db/lens.db', r.backupPath);
    expect(r.message).toContain(r.backupPath);
    // The guidance must tell the user what to do.
    expect(r.message).toMatch(/backed up/);
  });

  it('stays alive on an in-memory DB with guidance when the backup fails', async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('corrupt'))
      .mockResolvedValueOnce('memory');
    const rename = vi.fn(() => { throw new Error('EACCES'); });
    const d = deps({ open, rename });
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('degraded');
    if (r.kind !== 'degraded') return;
    expect(r.store).toBe('memory');
    expect(open).toHaveBeenLastCalledWith(MEMORY_DB_PATH);
    expect(r.message).toMatch(/will be saved/);
  });

  it('falls back to an in-memory DB when opening fails even with no file', async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('wasm load failed'))
      .mockResolvedValueOnce('memory');
    const d = deps({ open, exists: vi.fn(() => false) });
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('degraded');
    expect(d.rename).not.toHaveBeenCalled();
  });

  it('returns failed without throwing when even the in-memory DB fails', async () => {
    const open = vi.fn(async () => { throw new Error('boom'); });
    const d = deps({ open });
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('failed');
    if (r.kind !== 'failed') return;
    expect(r.message).toMatch(/could not be opened/);
  });
});
