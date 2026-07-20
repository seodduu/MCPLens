import { EventEmitter } from 'node:events';
import type { HookEnvelope, ToolObservation } from './contracts.js';
import { InboxDrainer } from './drainer.js';
import { makeCorrelationKey } from './identity.js';
import type { ClaimedEnvelope, InboxOptions } from './inbox.js';

type MaybePromise<T> = T | Promise<T>;

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
}

export interface IngestedEvent {
  count: number;
  trigger: string;
}

export class IngestionCoordinator extends EventEmitter {
  private readonly drainer: InboxDrainer;
  private readonly transactionStore: TransactionalCoordinatorStore | null;

  constructor(private readonly options: IngestionCoordinatorOptions) {
    super();
    this.drainer = options.drainer ?? new InboxDrainer(options.inbox);
    this.transactionStore = validateTransactionStore(options.store);
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
