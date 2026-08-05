import chokidar, { type WatchOptions } from 'chokidar';
import { readFileSync, statSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ClientId, LogAdapter } from '../types.js';
import type { LensStore } from '../store/store.js';
import { clientLogRoots } from '../paths.js';

export type ReconcileTrigger = 'hook' | 'chokidar' | (string & {});
export type ReconcileReceipt = {
  trigger: ReconcileTrigger;
  status: 'ingested' | 'skipped' | 'rejected' | 'failed';
  client: ClientId | null;
  filePath: string;
  parseErrors: number;
  errorCode: 'unsupported-path' | 'outside-root' | 'not-regular-file' |
    'transcript-missing' | 'read-failed' | 'parse-failed' | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;
type WatcherHandle = {
  on(event: 'add' | 'change', listener: (filePath: string) => void): WatcherHandle;
  close(): Promise<void> | void;
};
export type LogWatcherOptions = {
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
  allowedRoots?: (client: ClientId) => string[];
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  onReceipt?: (receipt: ReconcileReceipt) => void;
  watchFactory?: (paths: string[], options: WatchOptions) => WatcherHandle;
};

type PendingRequest = {
  trigger: ReconcileTrigger;
  promise: Promise<ReconcileReceipt>;
  resolve: (receipt: ReconcileReceipt) => void;
};
type PendingReconciliation = {
  requests: PendingRequest[];
};

export class LogWatcher extends EventEmitter {
  private watcher: WatcherHandle | null = null;
  private pending = new Map<string, PendingReconciliation>();
  private readonly debounceMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly allowedRoots: (client: ClientId) => string[];
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly onReceipt: ((receipt: ReconcileReceipt) => void) | undefined;
  private readonly watchFactory: (paths: string[], options: WatchOptions) => WatcherHandle;

  constructor(
    private store: LensStore,
    private adapters: LogAdapter[],
    options: LogWatcherOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? 50;
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 1_000, 3_000];
    this.allowedRoots = options.allowedRoots ?? clientLogRoots;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.onReceipt = options.onReceipt;
    this.watchFactory = options.watchFactory ?? ((paths, watchOptions) => (
      chokidar.watch(paths, watchOptions)
    ));
  }

  async backfill(): Promise<{ files: number; parseErrors: number }> {
    let files = 0, parseErrors = 0;
    for (const adapter of this.adapters)
      for (const root of adapter.sessionRoots()) {
        const canonicalRoot = canonicalDirectory(root);
        if (canonicalRoot === null) continue;
        for (const f of walk(root))
          if (adapter.matches(f)) {
            const canonicalFile = canonicalRegularFile(f, canonicalRoot);
            if (canonicalFile === null) continue;
            const result = this.ingestFile(adapter, canonicalFile);
            if (result) {
              if (result.status === 'ingested') files++;
              parseErrors += result.parseErrors;
            }
          }
      }
    this.store.save();
    return { files, parseErrors };
  }

  start(): void {
    const roots = this.adapters.flatMap((a) => a.sessionRoots()).filter(existsSync);
    this.watcher = this.watchFactory(roots, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });
    const onFile = (f: string) => { void this.reconcilePath(f, 'chokidar'); };
    this.watcher.on('add', onFile).on('change', onFile);
  }

  reconcilePath(filePath: string, trigger: ReconcileTrigger): Promise<ReconcileReceipt> {
    const key = path.resolve(filePath);
    const request = this.pendingRequest(trigger);
    const existing = this.pending.get(key);
    if (existing) {
      existing.requests.push(request);
      return request.promise;
    }

    const pending: PendingReconciliation = { requests: [request] };
    this.pending.set(key, pending);
    this.setTimer(() => { void this.performReconciliation(key, pending); }, this.debounceMs);
    return request.promise;
  }

  async stop(): Promise<void> { await this.watcher?.close(); this.watcher = null; }

  /** Returns whether anything was actually parsed and ingested (null when the mtime cursor matches); ingestion also returns parseErrors */
  private ingestFile(
    adapter: LogAdapter,
    filePath: string,
  ): { status: 'ingested' | 'failed'; parseErrors: number } | null {
    let mtimeMs: number;
    let content: string;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
      const cursor = this.store.getCursor(filePath);
      if (cursor && cursor.mtimeMs === mtimeMs) return null;
      content = readFileSync(filePath, 'utf8');
    } catch {
      // The file vanished after the event, or cannot be read: skip
      return null;
    }
    // MVP: full re-parse (safe because ingest is idempotent per session); the cursor only decides skips
    try {
      const result = adapter.parseFile(filePath, content);
      this.store.ingest(result);
      this.store.setCursor(filePath, Buffer.byteLength(content), mtimeMs);
      return { status: 'ingested', parseErrors: result.parseErrors };
    } catch {
      return { status: 'failed', parseErrors: 1 };
    }
  }

  private async performReconciliation(
    requestedPath: string,
    pending: PendingReconciliation,
  ): Promise<void> {
    const firstTrigger = pending.requests[0].trigger;
    let receipt = this.receipt(
      firstTrigger, null, requestedPath, 'failed', 'parse-failed', 1,
    );
    try {
      const adapter = this.adapters.find((candidate) => candidate.matches(requestedPath));
      if (!adapter) {
        receipt = this.receipt(firstTrigger, null, requestedPath, 'rejected', 'unsupported-path');
      } else if (!this.isWithinAllowedRoot(requestedPath, adapter.client, false)) {
        receipt = this.receipt(firstTrigger, adapter.client, requestedPath, 'rejected', 'outside-root');
      } else {
        receipt = await this.reconcileWithRetries(adapter, requestedPath, firstTrigger);
      }
    } catch {
      // Keep the explicit failure receipt; every debounced caller still settles below.
    } finally {
      if (this.pending.get(requestedPath) === pending) this.pending.delete(requestedPath);
      for (const request of pending.requests) {
        const callerReceipt = { ...receipt, trigger: request.trigger };
        try {
          this.recordReceipt(callerReceipt);
        } finally {
          request.resolve(callerReceipt);
        }
      }
    }
  }

  private async reconcileWithRetries(
    adapter: LogAdapter,
    requestedPath: string,
    trigger: ReconcileTrigger,
  ): Promise<ReconcileReceipt> {
    for (let attempt = 0; ; attempt++) {
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(requestedPath);
      } catch {
        if (attempt < this.retryDelaysMs.length) {
          await this.delay(this.retryDelaysMs[attempt]);
          continue;
        }
        return this.receipt(
          trigger, adapter.client, requestedPath, 'rejected', 'transcript-missing',
        );
      }

      if (!this.isWithinAllowedRoot(resolvedPath, adapter.client, true)) {
        return this.receipt(trigger, adapter.client, resolvedPath, 'rejected', 'outside-root');
      }
      try {
        if (!statSync(resolvedPath).isFile()) {
          return this.receipt(
            trigger, adapter.client, resolvedPath, 'rejected', 'not-regular-file',
          );
        }
      } catch {
        return this.receipt(trigger, adapter.client, resolvedPath, 'failed', 'read-failed');
      }

      const cursor = this.store.getCursor(resolvedPath);
      let content: string;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(resolvedPath).mtimeMs;
        if (cursor && cursor.mtimeMs === mtimeMs) {
          return this.receipt(trigger, adapter.client, resolvedPath, 'skipped', null);
        }
        content = readFileSync(resolvedPath, 'utf8');
      } catch {
        return this.receipt(trigger, adapter.client, resolvedPath, 'failed', 'read-failed');
      }

      try {
        const result = adapter.parseFile(resolvedPath, content);
        try {
          // Persist the ingest and its cursor advance inside one transaction so a
          // single commit/save flushes both together. LensStore.commit() now
          // writes to disk, so ingest() already persists on its own; a separate
          // save() would double-persist and split the data from its cursor.
          this.store.begin();
          this.store.ingest(result);
          this.store.setCursor(resolvedPath, Buffer.byteLength(content), mtimeMs);
          this.store.commit();
        } catch {
          // The commit/save did not durably land. Roll the in-memory cursor back
          // so the idempotent ingest replays on the next request.
          try { this.store.rollback(); } catch { /* transaction already settled */ }
          this.store.setCursor(
            resolvedPath,
            cursor?.byteOffset ?? 0,
            cursor?.mtimeMs ?? -1,
          );
          return this.receipt(
            trigger, adapter.client, resolvedPath, 'failed', 'parse-failed', 1,
          );
        }
        this.emitIsolated('ingested', resolvedPath);
        return this.receipt(
          trigger, adapter.client, resolvedPath, 'ingested', null, result.parseErrors,
        );
      } catch {
        return this.receipt(trigger, adapter.client, resolvedPath, 'failed', 'parse-failed', 1);
      }
    }
  }

  private isWithinAllowedRoot(filePath: string, client: ClientId, rootsAreCanonical: boolean): boolean {
    return this.allowedRoots(client).some((root) => {
      let allowedRoot = path.resolve(root);
      if (rootsAreCanonical) {
        try { allowedRoot = realpathSync(allowedRoot); } catch { return false; }
      }
      return isWithin(allowedRoot, path.resolve(filePath));
    });
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => { this.setTimer(resolve, delayMs); });
  }

  private pendingRequest(trigger: ReconcileTrigger): PendingRequest {
    let resolve!: (receipt: ReconcileReceipt) => void;
    const promise = new Promise<ReconcileReceipt>((done) => { resolve = done; });
    return { trigger, promise, resolve };
  }

  private receipt(
    trigger: ReconcileTrigger,
    client: ClientId | null,
    filePath: string,
    status: ReconcileReceipt['status'],
    errorCode: ReconcileReceipt['errorCode'],
    parseErrors = 0,
  ): ReconcileReceipt {
    return { trigger, client, filePath, status, errorCode, parseErrors };
  }

  private recordReceipt(receipt: ReconcileReceipt): void {
    try { this.onReceipt?.(receipt); } catch { /* observer failures do not stop ingestion */ }
    this.emitIsolated('receipt', receipt);
  }

  private emitIsolated(event: 'ingested' | 'receipt', value: unknown): void {
    for (const listener of this.rawListeners(event)) {
      try { listener.call(this, value); } catch { /* continue observer fan-out */ }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
  );
}

function canonicalDirectory(directoryPath: string): string | null {
  try {
    const canonicalPath = realpathSync(directoryPath);
    return statSync(canonicalPath).isDirectory() ? canonicalPath : null;
  } catch {
    return null;
  }
}

function canonicalRegularFile(filePath: string, canonicalRoot: string): string | null {
  try {
    const canonicalPath = realpathSync(filePath);
    if (!isWithin(canonicalRoot, canonicalPath)) return null;
    return statSync(canonicalPath).isFile() ? canonicalPath : null;
  } catch {
    return null;
  }
}

function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory: skip it and continue the rest of the backfill
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else out.push(p);
  }
  return out;
}
