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
  rmSync,
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
  sweepReapingDirs,
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
  // Entries left by an older version (colon file names) count as the same delivery. Otherwise the
  // same envelope queues under two names right after an upgrade. The DB does filter by
  // observation_id, but there is no reason to create the duplicate work at all.
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
    // Renaming without deleting would pile up one directory per delivery.
    rmSync(reaping, { recursive: true, force: true });
  } catch (error) {
    if (!isBusy(error) && !isCode(error, 'ENOENT')) throw error;
  }
}

export function claimPending(opts: InboxOptions = {}): ClaimBatch {
  const paths = inboxPaths(opts);
  const now = (opts.now ?? (() => new Date()))();
  recoverStaleProcessing(paths, opts);
  // Lock debris left by an older version is reclaimed in one pass during the drain, keeping the delivery path light.
  sweepReapingDirs(paths.locks);

  const claims: ClaimedEnvelope[] = [];
  let parseErrors = 0;
  for (const filename of readdirSync(paths.pending).filter((name) => name.endsWith('.json')).sort()) {
    const deliveryId = deliveryIdFromStem(filename.slice(0, -'.json'.length));
    // A colon file name left by an older version is migrated to the canonical name here; otherwise
    // it diverges from the canonical `.processing` path markProcessed builds and completion fails.
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
 * Encodes a deliveryId safely into a file name.
 *
 * A deliveryId can look like `native:<hash>` / `fallback:<hash>` (identity.ts), and `:` is a
 * reserved file-name character on Windows. NTFS reads it as alternate-data-stream syntax, so
 * `pending\native:x.json` becomes a hidden stream of an empty file called `native`, the directory
 * listing shows only `native` (which does not end in `.json`), and claimPending skips it forever,
 * losing the tool-call hook envelope entirely (measured on Windows).
 *
 * `~` is not in the character set checkedDeliveryId allows, so the substitution stays unambiguous,
 * and it is legal on every target file system. The deliveryId format itself is left alone: it must
 * not diverge from the values produced by already-installed plugin runtimes (bundled copies).
 */
function fileStem(deliveryId: string): string {
  return deliveryId.replaceAll(':', '~');
}

/**
 * Recovers the deliveryId from a file name. Colon file names left by an older version
 * (macOS/Linux) contain no `~`, so they pass through unchanged and stay readable after an upgrade.
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
    // Colon names left by an older version are recovered against the canonical name too.
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
