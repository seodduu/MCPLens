import { EventEmitter } from 'node:events';
import chokidar, { type WatchOptions } from 'chokidar';
import type { HookEnvelope, ToolObservation } from './contracts.js';
import { InboxDrainer } from './drainer.js';
import { makeCorrelationKey } from './identity.js';
import { inboxPaths, type ClaimedEnvelope, type InboxOptions } from './inbox.js';

type MaybePromise<T> = T | Promise<T>;
type TimerHandle = ReturnType<typeof setTimeout>;
export type PendingWatchHandle = {
  on(event: 'add' | 'ready', listener: (path?: string) => void): PendingWatchHandle;
  close(): Promise<void> | void;
};

interface CoordinatorStoreBase {
  upsertObservation: (observation: ToolObservation) => MaybePromise<void>;
}

export interface TransactionalCoordinatorStore extends CoordinatorStoreBase {
  begin: () => MaybePromise<void>;
  commit: () => MaybePromise<void>;
  rollback: () => MaybePromise<void>;
}

export interface NonTransactionalCoordinatorStore extends CoordinatorStoreBase {
  begin?: never;
  commit?: never;
  rollback?: never;
}

export type CoordinatorStore = TransactionalCoordinatorStore | NonTransactionalCoordinatorStore;

export interface IngestionResult {
  ingested: number;
  parseErrors: number;
}

export interface IngestionCoordinatorOptions {
  inbox?: InboxOptions;
  store: CoordinatorStore;
  reconcile?: (path: string, trigger: string) => MaybePromise<IngestionResult>;
  drainer?: InboxDrainer;
  /** pending watcher factory (injected in tests). Defaults to chokidar.watch. */
  watchFactory?: (paths: string[], options: WatchOptions) => PendingWatchHandle;
  /** debounce timer injection (tests). Defaults to setTimeout. */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  /** debounce delay in ms. Defaults to 50 (same as LogWatcher). */
  drainDebounceMs?: number;
}

export interface IngestedEvent {
  count: number;
  trigger: string;
}

export class IngestionCoordinator extends EventEmitter {
  private readonly drainer: InboxDrainer;
  private readonly transactionStore: TransactionalCoordinatorStore | null;
  private readonly watchFactory: (paths: string[], options: WatchOptions) => PendingWatchHandle;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly drainDebounceMs: number;
  private pendingWatcher: PendingWatchHandle | null = null;
  private drainTimer: TimerHandle | null = null;
  private drainScheduled = false;
  private drainInFlight = false;
  private drainQueued = false;
  private paused = false;

  constructor(private readonly options: IngestionCoordinatorOptions) {
    super();
    this.drainer = options.drainer ?? new InboxDrainer(options.inbox);
    this.transactionStore = validateTransactionStore(options.store);
    this.watchFactory = options.watchFactory
      ?? ((paths, watchOptions) => chokidar.watch(paths, watchOptions) as unknown as PendingWatchHandle);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.drainDebounceMs = options.drainDebounceMs ?? 50;
  }

  async drainInbox(): Promise<IngestionResult> {
    const claims = this.drainer.claim();
    let ingested = 0;
    let failure: unknown;

    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index]!;
      try {
        await this.persist(claim.envelope);
        this.drainer.complete(claim);
        ingested += 1;
      } catch (error) {
        failure = error;
        this.releaseAll(claims.slice(index));
        break;
      }
    }

    if (ingested > 0) this.emit('ingested', { count: ingested, trigger: 'inbox' });
    if (failure !== undefined) throw failure;
    return { ingested, parseErrors: claims.parseErrors };
  }

  /** Starts watching pending and drains once after chokidar's initial scan (ready) to absorb the backlog. Idempotent. */
  async startDraining(): Promise<void> {
    if (this.paused) return;               // a promotion while paused must not revive collection
    if (this.pendingWatcher) return;
    const pendingDir = inboxPaths(this.options.inbox ?? {}).pending; // ensures the directory exists
    const watcher = this.watchFactory([pendingDir], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });
    this.pendingWatcher = watcher;                        // set before the await, strengthening idempotence
    watcher.on('add', () => this.scheduleDrain());        // wired before awaiting ready, so no add after ready is lost
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve())); // wait for the initial scan to finish
    if (this.pendingWatcher !== watcher) return;          // stopDraining happened during startup: never drain or rewire a closed watcher
    await this.drainInbox();                              // runs after ready, absorbing what the scan suppressed plus pre-existing files
  }

  /** Stops watching. An in-flight drain is allowed to finish. Idempotent. */
  async stopDraining(): Promise<void> {
    const watcher = this.pendingWatcher;
    this.pendingWatcher = null;
    this.drainScheduled = false;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    await watcher?.close();
  }

  /** Pauses hook collection (for this session). Pending envelopes stay in the inbox and are absorbed on resume. Idempotent. */
  async pause(): Promise<void> {
    this.paused = true;
    await this.stopDraining();
  }

  /**
   * Clears the pause. The caller resumes watching with startDraining(): only the extension, not
   * core, knows whether resuming is safe (whether it holds the writer lease). Idempotent.
   */
  resume(): void {
    this.paused = false;
  }

  get isPaused(): boolean { return this.paused; }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;          // the debounce window is already open
    this.drainScheduled = true;
    this.drainTimer = this.setTimer(() => { void this.runDrain(); }, this.drainDebounceMs);
  }

  private async runDrain(): Promise<void> {
    this.drainScheduled = false;
    this.drainTimer = null;
    if (!this.pendingWatcher) return;          // stopped during the window: skip (safe demotion)
    if (this.drainInFlight) { this.drainQueued = true; return; }
    this.drainInFlight = true;
    try {
      await this.drainInbox();
    } catch (error) {
      this.emit('drain-error', error);         // the extension absorbs StaleWriterError
    } finally {
      this.drainInFlight = false;
      if (this.drainQueued) {
        this.drainQueued = false;
        this.scheduleDrain();                  // trailing coalescing
      }
    }
  }

  async reconcilePath(path: string, trigger: string): Promise<IngestionResult> {
    if (!this.options.reconcile) return { ingested: 0, parseErrors: 0 };
    const result = await this.options.reconcile(path, trigger);
    if (result.ingested > 0) this.emit('ingested', { count: result.ingested, trigger });
    return result;
  }

  private async persist(envelope: HookEnvelope): Promise<void> {
    let began = false;
    try {
      if (this.transactionStore) {
        await this.transactionStore.begin();
        began = true;
      }
      await this.options.store.upsertObservation(toObservation(envelope));
      await this.transactionStore?.commit();
    } catch (error) {
      if (began && this.transactionStore) {
        try {
          await this.transactionStore.rollback();
        } catch {
          // Preserve the insertion/commit failure that caused claim release.
        }
      }
      throw error;
    }
  }

  private releaseAll(claims: ClaimedEnvelope[]): void {
    for (const claim of claims) {
      try {
        this.drainer.release(claim);
      } catch {
        // A stale .processing file is recovered by H1's lease-based recovery.
      }
    }
  }
}

function validateTransactionStore(store: CoordinatorStore): TransactionalCoordinatorStore | null {
  const callbacks = [store.begin, store.commit, store.rollback];
  if (callbacks.every((callback) => callback === undefined)) return null;
  if (callbacks.every((callback) => typeof callback === 'function')) {
    return store as TransactionalCoordinatorStore;
  }
  throw new TypeError(
    'Coordinator store transaction callbacks must provide begin, commit, and rollback together',
  );
}

function toObservation(envelope: HookEnvelope): ToolObservation {
  const identity = {
    client: envelope.client,
    externalSessionId: envelope.externalSessionId,
    externalTurnId: envelope.externalTurnId,
    externalCallId: envelope.externalCallId,
    phase: envelope.phase,
    toolName: envelope.toolName,
    inputFingerprint: envelope.inputFingerprint,
  };
  return {
    ...envelope,
    source: 'hook',
    correlationKey: makeCorrelationKey(identity),
    correlationConfidence: envelope.externalCallId === null ? 'medium' : 'high',
    responseTokens: null,
    loadedTokens: null,
  };
}
