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
  /** pending 워처 팩토리(테스트 주입). 기본 chokidar.watch. */
  watchFactory?: (paths: string[], options: WatchOptions) => PendingWatchHandle;
  /** debounce 타이머 주입(테스트). 기본 setTimeout. */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  /** debounce 지연(ms). 기본 50(LogWatcher와 동일). */
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
  private drainScheduled = false;
  private drainInFlight = false;
  private drainQueued = false;

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

  /** pending 감시를 시작하고, chokidar 초기 스캔(ready) 완료 후 1회 drain(밀린 봉투 흡수). 멱등. */
  async startDraining(): Promise<void> {
    if (this.pendingWatcher) return;
    const pendingDir = inboxPaths(this.options.inbox ?? {}).pending; // 디렉토리 생성 보장
    const watcher = this.watchFactory([pendingDir], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });
    this.pendingWatcher = watcher;                        // await 이전에 세팅 → 멱등성 강화
    watcher.on('add', () => this.scheduleDrain());        // ready await 이전에 배선 → ready 이후 add 무손실
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve())); // 초기 스캔 종료 대기
    if (this.pendingWatcher !== watcher) return;          // startup 중 stopDraining 발생 → 닫힌 워처 drain/재배선 금지
    await this.drainInbox();                              // ready 이후 실행 → 스캔 억제분 + 기존 파일 흡수
  }

  /** 감시를 멈춘다. 인플라이트 drain은 자연 종료시킨다. 멱등. */
  async stopDraining(): Promise<void> {
    const watcher = this.pendingWatcher;
    this.pendingWatcher = null;
    this.drainScheduled = false;
    await watcher?.close();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;          // debounce 창이 이미 열림
    this.drainScheduled = true;
    this.setTimer(() => { void this.runDrain(); }, this.drainDebounceMs);
  }

  private async runDrain(): Promise<void> {
    this.drainScheduled = false;
    if (!this.pendingWatcher) return;          // 창 도중 stop됨 → 스킵(강등 안전)
    if (this.drainInFlight) { this.drainQueued = true; return; }
    this.drainInFlight = true;
    try {
      await this.drainInbox();
    } catch (error) {
      this.emit('drain-error', error);         // 확장이 StaleWriterError 흡수
    } finally {
      this.drainInFlight = false;
      if (this.drainQueued) {
        this.drainQueued = false;
        this.scheduleDrain();                  // 트레일링 코얼레싱
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
