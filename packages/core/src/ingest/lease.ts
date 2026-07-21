import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface Lease { token: string; expiresAt: number; }

// ── 이동해 온 저수준 (installLease/readLease/takeOverLease/lockInstanceToken/reapingPath/isBusy/isCode) ──
// inbox.ts에서 verbatim 이동. LockLease 타입만 Lease로 이름을 바꿔 사용.

export function installLease(lockPath: string, lease: Lease): boolean {
  const candidate = `${lockPath}.candidate-${lease.token}`;
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, 'owner.json'), JSON.stringify(lease), { mode: 0o600 });
  try {
    renameSync(candidate, lockPath);
    return true;
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    if (isBusy(error)) return false;
    throw error;
  }
}

export function readLease(lockPath: string): Lease | null {
  try {
    const raw = readFileSync(join(lockPath, 'owner.json'), 'utf8');
    let value: Partial<Lease>;
    try {
      value = JSON.parse(raw) as Partial<Lease>;
    } catch {
      return { token: lockInstanceToken(lockPath, raw), expiresAt: 0 };
    }
    return typeof value.token === 'string' && typeof value.expiresAt === 'number'
      ? { token: value.token, expiresAt: value.expiresAt }
      : { token: lockInstanceToken(lockPath, raw), expiresAt: 0 };
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return existsSync(lockPath) ? { token: lockInstanceToken(lockPath, ''), expiresAt: 0 } : null;
    }
    throw error;
  }
}

function lockInstanceToken(lockPath: string, content: string): string {
  const stat = statSync(lockPath);
  return createHash('sha256')
    .update(`${stat.ino}:${stat.ctimeMs}:${stat.birthtimeMs}:${content}`)
    .digest('hex');
}

export function reapingPath(lockPath: string, token: string): string {
  return `${lockPath}.reaping-${createHash('sha256').update(token).digest('hex')}`;
}

export function takeOverLease(lockPath: string, token: string): boolean {
  const reaping = reapingPath(lockPath, token);
  try {
    renameSync(lockPath, reaping);
    return true;
  } catch (error) {
    if (isBusy(error) || isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

export function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

export function isBusy(error: unknown): boolean {
  return isCode(error, 'EEXIST') || isCode(error, 'ENOTEMPTY');
}

/** 한 번 시도: 설치 성공 또는 만료 리스 인수 후 설치. 유효 홀더가 있으면 null. */
export function acquireLease(lockPath: string, ttlMs: number, nowMs: () => number = () => Date.now()): Lease | null {
  const now = nowMs();
  const lease: Lease = { token: randomUUID(), expiresAt: now + ttlMs };
  if (installLease(lockPath, lease)) return lease;
  const current = readLease(lockPath);
  if (current && current.expiresAt <= now && takeOverLease(lockPath, current.token)) {
    const retry: Lease = { token: randomUUID(), expiresAt: nowMs() + ttlMs };
    if (installLease(lockPath, retry)) return retry;
  }
  return null;
}

/** 내가 여전히 홀더면 만료 연장(원자적 owner.json 교체). 인수당했으면 null. */
export function renewLease(lockPath: string, token: string, ttlMs: number, nowMs: () => number = () => Date.now()): Lease | null {
  const current = readLease(lockPath);
  if (!current || current.token !== token) return null;
  const renewed: Lease = { token, expiresAt: nowMs() + ttlMs };
  const tmp = join(lockPath, `.owner.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(renewed), { mode: 0o600 });
    renameSync(tmp, join(lockPath, 'owner.json'));
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (isCode(error, 'ENOENT')) return null; // 락 디렉토리 사라짐(인수됨)
    throw error;
  }
  const after = readLease(lockPath);
  return after && after.token === token ? after : null;
}

/** 내 토큰일 때만 해제하고 흔적 정리. */
export function releaseLease(lockPath: string, token: string): void {
  if (readLease(lockPath)?.token !== token) return;
  const reaping = reapingPath(lockPath, token);
  try {
    renameSync(lockPath, reaping);
    rmSync(reaping, { recursive: true, force: true });
  } catch (error) {
    if (!isCode(error, 'ENOENT') && !isBusy(error)) throw error;
  }
}
