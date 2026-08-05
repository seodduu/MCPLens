// packages/cli/src/writer-lease.ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLease, renewLease, releaseLease, dbWriterLockPath, type Lease } from '@mcp-lens/core';

/**
 * Writer lease for the CLI.
 *
 * The save path is "export the whole sql.js file + atomic rename", so exactly one process may
 * write the DB file. If the CLI calls save() without a lease while the VS Code extension is
 * alive, every observation the extension ingested after the CLI opened the file is overwritten
 * and lost. Write commands therefore contend for the same lock as the extension
 * (dbWriterLockPath), and only the winner saves.
 *
 * It uses the same low-level API as the extension's WriterLeaseManager (core's
 * acquire/renew/releaseLease), but the CLI is a one-shot process, so it needs no
 * demote/promote state machine: acquire or abort.
 */

export interface WriterLeaseDeps {
  acquire: (lockPath: string, ttlMs: number) => Lease | null;
  renew: (lockPath: string, token: string, ttlMs: number) => Lease | null;
  release: (lockPath: string, token: string) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  ensureDir: (dir: string) => void;
  lockPath: () => string;
  ttlMs: number;
  renewMs: number;
}

const DEFAULT_DEPS: WriterLeaseDeps = {
  acquire: acquireLease,
  renew: renewLease,
  release: releaseLease,
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    // Keeps the heartbeat timer from holding the event loop open and preventing the CLI from exiting.
    timer.unref?.();
    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  ensureDir: (dir) => { mkdirSync(dir, { recursive: true }); },
  lockPath: () => dbWriterLockPath(),
  ttlMs: 30_000,
  renewMs: 10_000,
};

export const LEASE_BUSY_MESSAGE =
  'The VS Code extension is writing the MCP Lens DB, so this command cannot run right now.\n' +
  'Close the extension window (or the other running mcp-lens) and try again. It may also clear on its own shortly.';

export interface WriterLeaseHandle {
  /** Am I still the holder? Flips to false once the heartbeat detects a takeover. */
  isHolder(): boolean;
  /** Releasing more than once is safe. */
  release(): void;
}

export type WriterLeaseResult =
  | { ok: true; lease: WriterLeaseHandle }
  | { ok: false; message: string };

/** Tries the lease once. Returns a failure with guidance when another valid holder exists. */
export function acquireWriterLease(overrides: Partial<WriterLeaseDeps> = {}): WriterLeaseResult {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const lockPath = deps.lockPath();
  // LensStore.open() does not create ~/.mcplens until the first save(), so make room for the lock first.
  deps.ensureDir(dirname(lockPath));

  let lease = deps.acquire(lockPath, deps.ttlMs);
  if (!lease) return { ok: false, message: LEASE_BUSY_MESSAGE };

  let timer: unknown = deps.setInterval(() => {
    if (!lease) return;
    const renewed = deps.renew(lockPath, lease.token, deps.ttlMs);
    lease = renewed; // null means taken over: we become a non-holder at once and the write guard blocks save
    if (!renewed) stopTimer();
  }, deps.renewMs);

  function stopTimer(): void {
    if (timer !== undefined) { deps.clearInterval(timer); timer = undefined; }
  }

  return {
    ok: true,
    lease: {
      isHolder: () => lease !== null,
      release: () => {
        stopTimer();
        if (lease) { deps.release(lockPath, lease.token); lease = null; }
      },
    },
  };
}

/**
 * Takes the lease, runs body, and always releases it (including on the exception path).
 * On acquisition failure body never runs, which means the DB is never even opened.
 */
export async function withWriterLease<T>(
  body: (lease: WriterLeaseHandle) => Promise<T>,
  overrides: Partial<WriterLeaseDeps> = {},
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const acquired = acquireWriterLease(overrides);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, value: await body(acquired.lease) };
  } finally {
    acquired.lease.release();
  }
}
