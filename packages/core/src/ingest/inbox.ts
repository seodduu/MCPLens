import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inboxPath } from '../paths.js';
import type { HookEnvelope } from './contracts.js';
import {
  installLease,
  isBusy,
  isCode,
  readLease,
  reapingPath,
  takeOverLease,
  type Lease,
} from './lease.js';

const MAX_ENVELOPE_BYTES = 1024 * 1024;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
/** Exceeds the two-second hook budget while still guaranteeing eventual takeover. */
const LOCK_LEASE_MS = 5_000;
const LOCK_WAIT_MS = LOCK_LEASE_MS + 100;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface InboxOptions { root?: string; now?: () => Date; }
export interface ClaimedEnvelope { deliveryId: string; envelope: HookEnvelope; }
/** Array-compatible drain result with per-batch invalid-file accounting. */
export type ClaimBatch = ClaimedEnvelope[] & { readonly parseErrors: number };
export interface InboxPaths { root: string; pending: string; processed: string; locks: string; }

export class InboxLockBusyError extends Error {
  readonly code = 'INBOX_LOCK_BUSY';
  constructor(deliveryId: string) {
    super(`Inbox delivery lock is busy; retry ${deliveryId}`);
    this.name = 'InboxLockBusyError';
  }
}

export function inboxPaths(opts: InboxOptions = {}): InboxPaths {
  const root = opts.root ?? inboxPath();
  const paths = {
    root,
    pending: join(root, 'pending'),
    processed: join(root, 'processed'),
    locks: join(root, '.locks'),
  };
  secureDirectory(paths.root);
  secureDirectory(paths.pending);
  secureDirectory(paths.processed);
  secureDirectory(paths.locks);
  return paths;
}

export function enqueueEnvelope(
  env: HookEnvelope,
  opts: InboxOptions = {},
): 'queued' | 'duplicate' {
  const deliveryId = checkedDeliveryId(env.deliveryId);
  const paths = inboxPaths(opts);
  const stem = fileStem(deliveryId);
  const finalPath = join(paths.pending, `${stem}.json`);
  const committedPath = join(paths.locks, `${stem}.committed`);
  if (existsSync(finalPath)) return 'duplicate';

  const lockPath = join(paths.locks, `${stem}.lock`);
  const lease = acquireDeliveryLock(lockPath, opts);
  if (!lease) return 'duplicate';
  const now = (opts.now ?? (() => new Date()))();

  let tempPath: string | undefined;
  let uniqueCommit: string | undefined;
  try {
    if (existsSync(committedPath)) {
      if (deliveryExists(paths, deliveryId)) return 'duplicate';
      try {
        linkSync(committedPath, finalPath);
        return 'queued';
      } catch (error) {
        if (isCode(error, 'EEXIST')) return 'duplicate';
        throw error;
      }
    }
    if (deliveryExists(paths, deliveryId)) return 'duplicate';
    const serialized = serializeEnvelope(env);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) {
      throw new RangeError('Hook envelope exceeds the 1 MiB inbox limit');
    }

    tempPath = join(
      paths.pending,
      `.${stem}.${process.pid}.${now.getTime()}.tmp`,
    );
    const fd = openSync(tempPath, 'wx', 0o600);
    try {
      writeFileSync(fd, serialized, 'utf8');
    } finally {
      closeSync(fd);
    }
    uniqueCommit = join(paths.locks, `${stem}.commit-${lease.token}`);
    renameSync(tempPath, uniqueCommit);
    tempPath = undefined;
    chmodSync(uniqueCommit, 0o600);
    try {
      linkSync(uniqueCommit, committedPath);
    } catch (error) {
      if (isCode(error, 'EEXIST')) return 'duplicate';
      throw error;
    }
    try {
      linkSync(committedPath, finalPath);
    } catch (error) {
      if (isCode(error, 'EEXIST')) return 'duplicate';
      throw error;
    }
    return 'queued';
  } finally {
    if (tempPath && existsSync(tempPath)) unlinkSync(tempPath);
    if (uniqueCommit && existsSync(uniqueCommit)) unlinkSync(uniqueCommit);
    releaseDeliveryLock(lockPath, lease.token);
  }
}

function deliveryExists(paths: InboxPaths, deliveryId: string): boolean {
  // 구버전(콜론 파일명)이 남긴 항목도 같은 배달로 본다. 아니면 업그레이드 직후
  // 같은 봉투가 두 이름으로 큐에 쌓인다. DB가 observation_id로 걸러 주긴 하지만,
  // 중복 처리 자체를 만들 이유가 없다.
  const stems = [fileStem(deliveryId), deliveryId];
  return stems.some((stem) => existsSync(join(paths.pending, `${stem}.json`))
    || existsSync(join(paths.pending, `${stem}.processing`))
    || existsSync(join(paths.processed, `${stem}.json`)));
}

function acquireDeliveryLock(lockPath: string, opts: InboxOptions, wait = false): Lease | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const now = (opts.now ?? (() => new Date()))().getTime();
    const lease = { token: randomUUID(), expiresAt: now + LOCK_LEASE_MS };
    if (installLease(lockPath, lease)) return lease;
    const current = readLease(lockPath);
    if (current && current.expiresAt <= now && takeOverLease(lockPath, current.token)) continue;
    if (!wait || opts.now || Date.now() >= deadline) return null;
    Atomics.wait(WAIT_BUFFER, 0, 0, 5);
  }
}

function releaseDeliveryLock(lockPath: string, token: string): void {
  if (readLease(lockPath)?.token !== token) return;
  const reaping = reapingPath(lockPath, token);
  try {
    renameSync(lockPath, reaping);
  } catch (error) {
    if (!isBusy(error) && !isCode(error, 'ENOENT')) throw error;
  }
}

export function claimPending(opts: InboxOptions = {}): ClaimBatch {
  const paths = inboxPaths(opts);
  const now = (opts.now ?? (() => new Date()))();
  recoverStaleProcessing(paths, opts);

  const claims: ClaimedEnvelope[] = [];
  let parseErrors = 0;
  for (const filename of readdirSync(paths.pending).filter((name) => name.endsWith('.json')).sort()) {
    const deliveryId = deliveryIdFromStem(filename.slice(0, -'.json'.length));
    // 구버전이 남긴 콜론 파일명이라도 여기서 정규 이름으로 이관한다 — 그러지 않으면
    // markProcessed가 만드는 정규 `.processing` 경로와 어긋나 완료 처리에 실패한다.
    const stem = fileStem(deliveryId);
    const pendingPath = join(paths.pending, filename);
    const processingPath = join(paths.pending, `${stem}.processing`);
    const lockPath = join(paths.locks, `${stem}.lock`);
    const lease = acquireDeliveryLock(lockPath, opts);
    if (!lease) continue;
    try {
      try {
        utimesSync(pendingPath, now, now);
        renameSync(pendingPath, processingPath);
      } catch (error) {
        if (isCode(error, 'ENOENT')) continue;
        throw error;
      }
      try {
        const value: unknown = JSON.parse(readFileSync(processingPath, 'utf8'));
        if (!isHookEnvelope(value, deliveryId)) throw new InvalidEnvelopeError();
        claims.push({ deliveryId, envelope: value });
      } catch (error) {
        if (isCode(error, 'ENOENT')) continue;
        if (!(error instanceof SyntaxError) && !(error instanceof InvalidEnvelopeError)) throw error;
        parseErrors += 1;
        unlinkSync(processingPath);
      }
    } finally {
      releaseDeliveryLock(lockPath, lease.token);
    }
  }
  Object.defineProperty(claims, 'parseErrors', { value: parseErrors, enumerable: false });
  return claims as ClaimBatch;
}

export function markProcessed(claim: ClaimedEnvelope, opts: InboxOptions = {}): void {
  const deliveryId = checkedDeliveryId(claim.deliveryId);
  const paths = inboxPaths(opts);
  const stem = fileStem(deliveryId);
  const lockPath = join(paths.locks, `${stem}.lock`);
  const lease = acquireDeliveryLock(lockPath, opts, true);
  if (!lease) throw new InboxLockBusyError(deliveryId);
  const source = join(paths.pending, `${stem}.processing`);
  const destination = join(paths.processed, `${stem}.json`);
  try {
    renameSync(source, destination);
    chmodSync(destination, 0o600);
  } finally {
    releaseDeliveryLock(lockPath, lease.token);
  }
}

export function releaseClaim(claim: ClaimedEnvelope, opts: InboxOptions = {}): void {
  const deliveryId = checkedDeliveryId(claim.deliveryId);
  const paths = inboxPaths(opts);
  const stem = fileStem(deliveryId);
  const lockPath = join(paths.locks, `${stem}.lock`);
  const lease = acquireDeliveryLock(lockPath, opts, true);
  if (!lease) throw new InboxLockBusyError(deliveryId);
  try {
    renameSync(
      join(paths.pending, `${stem}.processing`),
      join(paths.pending, `${stem}.json`),
    );
  } finally {
    releaseDeliveryLock(lockPath, lease.token);
  }
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function checkedDeliveryId(deliveryId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(deliveryId)) {
    throw new Error('Invalid inbox delivery id');
  }
  return deliveryId;
}

/**
 * deliveryId를 파일명으로 안전하게 인코딩한다.
 *
 * deliveryId는 `native:<hash>` / `fallback:<hash>` 형태를 가질 수 있는데(identity.ts),
 * Windows에서 `:` 는 파일명 예약 문자다. NTFS는 이를 대체 데이터 스트림 문법으로
 * 해석하므로 `pending\native:x.json` 은 `native` 라는 빈 파일의 숨은 스트림이 되고,
 * 디렉터리 목록에는 `.json` 으로 끝나지 않는 `native` 만 남아 claimPending이
 * 영원히 건너뛴다 — 툴 호출 훅 봉투가 통째로 유실된다(실측: Windows).
 *
 * `~` 는 checkedDeliveryId가 허용하는 문자 집합에 없으므로 치환이 모호해지지 않고,
 * 모든 대상 파일 시스템에서 합법이다. deliveryId 형식 자체는 건드리지 않는다 —
 * 이미 설치된 플러그인 런타임(번들 사본)이 만들어내는 값과 어긋나면 안 된다.
 */
function fileStem(deliveryId: string): string {
  return deliveryId.replaceAll(':', '~');
}

/**
 * 파일명에서 deliveryId를 복원한다. 구버전이 남긴 콜론 파일명(macOS·Linux)에는
 * `~` 가 없으므로 그대로 통과한다 — 업그레이드 후에도 계속 읽힌다.
 */
function deliveryIdFromStem(stem: string): string {
  return stem.replaceAll('~', ':');
}

function serializeEnvelope(env: HookEnvelope): string {
  const persisted: HookEnvelope = {
    schemaVersion: env.schemaVersion,
    deliveryId: env.deliveryId,
    client: env.client,
    phase: env.phase,
    receivedAt: env.receivedAt,
    externalSessionId: env.externalSessionId,
    externalTurnId: env.externalTurnId,
    externalCallId: env.externalCallId,
    transcriptPath: env.transcriptPath,
    serverName: env.serverName,
    toolName: env.toolName,
    observedAt: env.observedAt,
    durationMs: env.durationMs,
    isError: env.isError,
    inputFingerprint: env.inputFingerprint,
  };
  return JSON.stringify(persisted);
}

function recoverStaleProcessing(paths: InboxPaths, opts: InboxOptions): void {
  const now = (opts.now ?? (() => new Date()))();
  for (const filename of readdirSync(paths.pending).filter((name) => name.endsWith('.processing'))) {
    // 구버전이 남긴 콜론 이름도 정규 이름 기준으로 복구한다.
    const stem = fileStem(deliveryIdFromStem(filename.slice(0, -'.processing'.length)));
    const processingPath = join(paths.pending, filename);
    const lockPath = join(paths.locks, `${stem}.lock`);
    const lease = acquireDeliveryLock(lockPath, opts);
    if (!lease) continue;
    try {
      if (now.getTime() - statSync(processingPath).mtimeMs < STALE_PROCESSING_MS) continue;
      const pendingPath = join(paths.pending, `${stem}.json`);
      if (!existsSync(pendingPath)) renameSync(processingPath, pendingPath);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    } finally {
      releaseDeliveryLock(lockPath, lease.token);
    }
  }
}

class InvalidEnvelopeError extends Error {}

const ENVELOPE_KEYS = [
  'schemaVersion', 'deliveryId', 'client', 'phase', 'receivedAt', 'externalSessionId',
  'externalTurnId', 'externalCallId', 'transcriptPath', 'serverName', 'toolName',
  'observedAt', 'durationMs', 'isError', 'inputFingerprint',
] as const;
const CLIENTS = new Set(['claude-code', 'codex', 'gemini-cli']);
const PHASES = new Set(['session-start', 'tool-before', 'tool-after', 'tool-failure', 'turn-stop', 'session-end']);

function isHookEnvelope(value: unknown, deliveryId: string): value is HookEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  const nullableString = (field: string) => item[field] === null || typeof item[field] === 'string';
  return keys.length === ENVELOPE_KEYS.length && keys.every((key) => ENVELOPE_KEYS.includes(key as typeof ENVELOPE_KEYS[number]))
    && item.schemaVersion === 1 && item.deliveryId === deliveryId
    && typeof item.deliveryId === 'string' && CLIENTS.has(String(item.client))
    && PHASES.has(String(item.phase)) && typeof item.receivedAt === 'string'
    && typeof item.externalSessionId === 'string' && nullableString('externalTurnId')
    && nullableString('externalCallId') && nullableString('transcriptPath')
    && nullableString('serverName') && nullableString('toolName')
    && typeof item.observedAt === 'string'
    && (item.durationMs === null || typeof item.durationMs === 'number')
    && (item.isError === null || typeof item.isError === 'boolean')
    && nullableString('inputFingerprint');
}
