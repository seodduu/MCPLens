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
  const owner = readOwner(lockPath);
  if (!owner) return owner;
  // 정체성(token)은 항상 owner.json에서. 만료(expiresAt)는 별도 사이드카(expiry.json)가
  // 존재하고 그 token이 owner의 token과 일치할 때만 반영한다(renew 소유물임을 표식).
  const expiry = readExpiry(lockPath);
  return expiry && expiry.token === owner.token
    ? { token: owner.token, expiresAt: expiry.expiresAt }
    : owner;
}

/** owner.json만으로 결정되는 정체성 리스. expiry 사이드카는 보지 않는다. */
function readOwner(lockPath: string): Lease | null {
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

/** 만료 사이드카를 읽는다. 없거나 형식이 어긋나면 null(=owner.json 만료를 사용). */
function readExpiry(lockPath: string): Lease | null {
  try {
    const raw = readFileSync(join(lockPath, 'expiry.json'), 'utf8');
    const value = JSON.parse(raw) as Partial<Lease>;
    return typeof value.token === 'string' && typeof value.expiresAt === 'number'
      ? { token: value.token, expiresAt: value.expiresAt }
      : null;
  } catch {
    return null;
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
  } catch (error) {
    if (isBusy(error) || isCode(error, 'ENOENT')) return false;
    throw error;
  }
  rmSync(reaping, { recursive: true, force: true });
  return true;
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

/**
 * 내가 여전히 홀더면 만료를 연장한다. 인수당했으면 null.
 *
 * RACE-FREE 불변식(정체성/만료 분리):
 * renew는 정체성의 원천인 owner.json을 절대 건드리지 않고, 만료만 담은 사이드카
 * expiry.json({token, expiresAt})을 tmp+rename으로 원자적 기록한다. check(readLease)와
 * write 사이에 경쟁자 B가 takeOverLease+installLease로 인수해도:
 *  - B의 owner.json은 renew가 안 쓰므로 정체성 오염 불가.
 *  - A가 쓴 expiry.json의 token(A)은 B의 owner token과 불일치 → readLease가 무시(B 만료도 안전).
 *  - write 후 재확인에서 owner token이 B이므로 A는 null을 받는다(A가 졌다).
 * additive & inbox-inert: inbox는 renew를 호출하지 않아 expiry.json이 없고 readLease 동작 불변.
 *
 * hooks.beforeWrite는 check 직후·기록 직전에 호출되는 테스트 전용 seam(레이스 재현용).
 * WriterLeaseManager는 이 인자를 넘기지 않으므로 무해하다.
 */
export function renewLease(
  lockPath: string,
  token: string,
  ttlMs: number,
  nowMs: () => number = () => Date.now(),
  hooks?: { beforeWrite?: () => void },
): Lease | null {
  const current = readLease(lockPath);
  if (!current || current.token !== token) return null;
  hooks?.beforeWrite?.();
  const sidecar: Lease = { token, expiresAt: nowMs() + ttlMs };
  const tmp = join(lockPath, `.expiry.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(sidecar), { mode: 0o600 });
    renameSync(tmp, join(lockPath, 'expiry.json'));
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
