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
  it('타임스탬프를 붙이고 파일명에 못 쓰는 콜론을 뺀다', () => {
    expect(corruptBackupPath('/home/u/.mcplens/lens.db', FIXED))
      .toBe('/home/u/.mcplens/lens.db.corrupt-2026-08-05T12-34-56.000Z');
  });
});

describe('openStoreWithRecovery', () => {
  it('정상이면 그대로 연다', async () => {
    const d = deps();
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('ok');
    expect(d.rename).not.toHaveBeenCalled();
  });

  it('손상된 DB는 백업하고 빈 DB로 다시 시작한다', async () => {
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
    // 사용자가 무엇을 해야 하는지 알 수 있는 한국어 안내여야 한다.
    expect(r.message).toMatch(/백업/);
  });

  it('백업이 실패하면 메모리 DB로 계속 살아 있고 안내를 낸다', async () => {
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
    expect(r.message).toMatch(/저장되지 않습니다/);
  });

  it('파일이 없는데도 열기가 실패하면 메모리 DB로 내려간다', async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('wasm load failed'))
      .mockResolvedValueOnce('memory');
    const d = deps({ open, exists: vi.fn(() => false) });
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('degraded');
    expect(d.rename).not.toHaveBeenCalled();
  });

  it('메모리 DB조차 실패하면 failed를 돌려주되 throw하지 않는다', async () => {
    const open = vi.fn(async () => { throw new Error('boom'); });
    const d = deps({ open });
    const r = await openStoreWithRecovery('/db/lens.db', d);
    expect(r.kind).toBe('failed');
    if (r.kind !== 'failed') return;
    expect(r.message).toMatch(/열지 못했습니다/);
  });
});
