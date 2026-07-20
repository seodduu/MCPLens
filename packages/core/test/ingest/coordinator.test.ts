import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookEnvelope, ToolObservation } from '../../src/ingest/contracts.js';
import {
  IngestionCoordinator,
  type CoordinatorStore,
} from '../../src/ingest/coordinator.js';
import { InboxDrainer } from '../../src/ingest/drainer.js';
import { enqueueEnvelope } from '../../src/ingest/inbox.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-coordinator-'));
  roots.push(root);
  return root;
}

function envelope(deliveryId: string): HookEnvelope {
  return {
    schemaVersion: 1,
    deliveryId,
    client: 'codex',
    phase: 'tool-after',
    receivedAt: '2026-07-20T00:00:01.000Z',
    externalSessionId: 'session-1',
    externalTurnId: 'turn-1',
    externalCallId: deliveryId,
    transcriptPath: null,
    serverName: 'github',
    toolName: 'get_issue',
    observedAt: '2026-07-20T00:00:00.000Z',
    durationMs: 12,
    isError: false,
    inputFingerprint: null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('IngestionCoordinator', () => {
  it.each([
    { begin: vi.fn() },
    { commit: vi.fn() },
    { rollback: vi.fn() },
    { begin: vi.fn(), commit: vi.fn() },
  ])('rejects an incomplete transaction callback set', (transaction) => {
    const store = {
      upsertObservation: vi.fn(),
      ...transaction,
    } as unknown as CoordinatorStore;

    expect(() => new IngestionCoordinator({ store })).toThrow(
      'Coordinator store transaction callbacks must provide begin, commit, and rollback together',
    );
  });

  it('orders begin, upsert, commit, then claim completion', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope('d1'), { root });
    const order: string[] = [];
    const drainer = new InboxDrainer({ root });
    const complete = drainer.complete.bind(drainer);
    vi.spyOn(drainer, 'complete').mockImplementation((claim) => {
      order.push('complete');
      complete(claim);
    });
    const coordinator = new IngestionCoordinator({
      drainer,
      store: {
        begin: () => { order.push('begin'); },
        upsertObservation: () => { order.push('upsert'); },
        commit: () => { order.push('commit'); },
        rollback: () => { order.push('rollback'); },
      },
    });

    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 1, parseErrors: 0 });
    expect(order).toEqual(['begin', 'upsert', 'commit', 'complete']);
  });

  it('rolls back a failed commit and releases the claim to pending', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope('d1'), { root });
    const order: string[] = [];
    const coordinator = new IngestionCoordinator({
      inbox: { root },
      store: {
        begin: () => { order.push('begin'); },
        upsertObservation: () => { order.push('upsert'); },
        commit: () => {
          order.push('commit');
          throw new Error('commit failed');
        },
        rollback: () => { order.push('rollback'); },
      },
    });

    await expect(coordinator.drainInbox()).rejects.toThrow('commit failed');
    expect(order).toEqual(['begin', 'upsert', 'commit', 'rollback']);
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
    expect(readdirSync(join(root, 'processed'))).toEqual([]);
  });

  it('processes the first item, restores a failed second item, and retries exactly once', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope('d1'), { root });
    enqueueEnvelope(envelope('d2'), { root });
    const materialized = new Map<string, ToolObservation>();
    const attempts: string[] = [];
    let failSecond = true;
    const coordinator = new IngestionCoordinator({
      inbox: { root },
      store: {
        upsertObservation(observation) {
          attempts.push(observation.deliveryId);
          if (observation.deliveryId === 'd2' && failSecond) {
            failSecond = false;
            throw new Error('insert failed');
          }
          materialized.set(observation.deliveryId, observation);
        },
      },
    });

    await expect(coordinator.drainInbox()).rejects.toThrow('insert failed');
    expect(readdirSync(join(root, 'processed'))).toEqual(['d1.json']);
    expect(readdirSync(join(root, 'pending'))).toEqual(['d2.json']);
    expect([...materialized.keys()]).toEqual(['d1']);

    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 1, parseErrors: 0 });
    expect(readdirSync(join(root, 'processed')).sort()).toEqual(['d1.json', 'd2.json']);
    expect(readdirSync(join(root, 'pending'))).toEqual([]);
    expect([...materialized.keys()].sort()).toEqual(['d1', 'd2']);
    expect(attempts).toEqual(['d1', 'd2', 'd2']);
  });

  it('emits ingested exactly once for a non-empty batch', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope('d1'), { root });
    enqueueEnvelope(envelope('d2'), { root });
    const coordinator = new IngestionCoordinator({
      inbox: { root },
      store: { upsertObservation: vi.fn() },
    });
    const listener = vi.fn();
    coordinator.on('ingested', listener);

    await expect(coordinator.drainInbox()).resolves.toEqual({ ingested: 2, parseErrors: 0 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ count: 2, trigger: 'inbox' });
  });

  it('delegates targeted path reconciliation with its trigger', async () => {
    const reconcile = vi.fn(async () => ({ ingested: 3, parseErrors: 1 }));
    const coordinator = new IngestionCoordinator({
      store: { upsertObservation: vi.fn() },
      reconcile,
    });

    await expect(coordinator.reconcilePath('/tmp/session.jsonl', 'hook')).resolves.toEqual({
      ingested: 3,
      parseErrors: 1,
    });
    expect(reconcile).toHaveBeenCalledWith('/tmp/session.jsonl', 'hook');
  });
});
