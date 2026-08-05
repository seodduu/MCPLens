import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookEnvelope } from '../../src/ingest/contracts.js';
import { IngestionCoordinator } from '../../src/ingest/coordinator.js';
import { enqueueEnvelope } from '../../src/ingest/inbox.js';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-coord-watch-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function envelope(deliveryId: string): HookEnvelope {
  return {
    schemaVersion: 1, deliveryId, client: 'codex', phase: 'tool-after',
    receivedAt: '2026-07-20T00:00:01.000Z', externalSessionId: 'session-1',
    externalTurnId: 'turn-1', externalCallId: deliveryId, transcriptPath: null,
    serverName: 'github', toolName: 'get_issue', observedAt: '2026-07-20T00:00:00.000Z',
    durationMs: 12, isError: false, inputFingerprint: null,
  };
}

// Injected fake watcher: add listeners fire manually, ready fires automatically on a microtask like
// the real chokidar, and whether it was closed is exposed.
function fakeWatch() {
  const listeners: Array<(p: string) => void> = [];
  let closed = false;
  const handle = {
    on(event: 'add' | 'ready', listener: (p?: string) => void) {
      if (event === 'ready') queueMicrotask(() => listener());
      else listeners.push(listener as (p: string) => void);
      return handle;
    },
    close() { closed = true; },
    emitAdd(p: string) { for (const l of [...listeners]) l(p); },
    get closed() { return closed; },
  };
  return handle;
}

// Manual timer: setTimer callbacks are collected and fired synchronously by flush, making debounce deterministic.
function manualTimer() {
  let queue: Array<() => void> = [];
  return {
    setTimer: (cb: () => void) => { queue.push(cb); return 0 as unknown as ReturnType<typeof setTimeout>; },
    flush: () => { const q = queue; queue = []; for (const cb of q) cb(); },
    get count() { return queue.length; },
  };
}

describe('IngestionCoordinator pending watcher', () => {
  it('drains the backlog immediately and then starts watching on startDraining', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope('backlog-1'), { root });
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert },
      inbox: { root },
      watchFactory: () => watch,
      setTimer: timer.setTimer,
    });

    await coord.startDraining();

    expect(upsert).toHaveBeenCalledTimes(1);       // the backlog is absorbed
    expect(watch.closed).toBe(false);               // watching started
    await coord.stopDraining();
  });

  it('absorbs envelopes present at ready through the initial drain, with no add event (race guard)', async () => {
    const root = temporaryRoot();
    // A file present in pending before ready (suppressed in the initial scan by ignoreInitial).
    enqueueEnvelope(envelope('present-at-ready'), { root });
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });

    await coord.startDraining();       // the initial drain runs after ready (a microtask)

    // The envelope is absorbed even though no add event ever fired.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(timer.count).toBe(0);       // scheduleDrain (the add path) is unused
    await coord.stopDraining();
  });

  it('makes an add event trigger exactly one drain after the debounce', async () => {
    const root = temporaryRoot();
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();       // the backlog is empty (upsert 0)
    upsert.mockClear();

    enqueueEnvelope(envelope('live-1'), { root });
    watch.emitAdd(join(root, 'pending', 'live-1.json'));
    timer.flush();
    await Promise.resolve();           // drain the microtask of runDrain
    await Promise.resolve();

    expect(upsert).toHaveBeenCalledTimes(1);
    await coord.stopDraining();
  });

  it('coalesces a burst (three consecutive adds) into a single drain', async () => {
    const root = temporaryRoot();
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();
    upsert.mockClear();

    enqueueEnvelope(envelope('b-1'), { root });
    watch.emitAdd(join(root, 'pending', 'b-1.json'));
    watch.emitAdd(join(root, 'pending', 'b-1.json'));
    watch.emitAdd(join(root, 'pending', 'b-1.json'));
    expect(timer.count).toBe(1);       // only one window opened
    timer.flush();
    await Promise.resolve(); await Promise.resolve();

    expect(upsert).toHaveBeenCalledTimes(1);
    await coord.stopDraining();
  });

  it('runs exactly one trailing drain for adds that arrive while a drain is in flight', async () => {
    const root = temporaryRoot();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    // The upsert of the first drain is held at a gate to make the in-flight state deterministic.
    const upsert = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate;
    });
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();       // the backlog is empty (upsert 0)

    // 1) first envelope: the drain starts and upsert blocks at the gate (drainInFlight=true).
    enqueueEnvelope(envelope('flight-1'), { root });
    watch.emitAdd(join(root, 'pending', 'flight-1.json'));
    timer.flush();
    await Promise.resolve();           // runDrain reaches drainInbox

    // 2) a second envelope arrives in flight: only drainQueued is set (no immediate drain).
    enqueueEnvelope(envelope('flight-2'), { root });
    watch.emitAdd(join(root, 'pending', 'flight-2.json'));
    timer.flush();
    await Promise.resolve();
    expect(calls).toBe(1);             // still only the first drain in progress

    // 3) release the gate: the first drain finishes and exactly one trailing drain is scheduled.
    release();
    while (timer.count === 0) await new Promise((r) => setTimeout(r, 0));
    timer.flush();
    while (upsert.mock.calls.length < 2) await new Promise((r) => setTimeout(r, 0));

    expect(upsert).toHaveBeenCalledTimes(2); // flight-1 plus trailing flight-2, no more than the coalescing allows
    await coord.stopDraining();
  });

  it('ignores adds after stopDraining and closes the watcher', async () => {
    const root = temporaryRoot();
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();
    upsert.mockClear();

    await coord.stopDraining();
    expect(watch.closed).toBe(true);

    enqueueEnvelope(envelope('after-stop'), { root });
    watch.emitAdd(join(root, 'pending', 'after-stop.json'));
    timer.flush();
    await Promise.resolve();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps start/stop idempotent', async () => {
    const root = temporaryRoot();
    const watches = [fakeWatch(), fakeWatch()];
    let made = 0;
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => watches[made++]!, setTimer: manualTimer().setTimer,
    });
    await coord.startDraining();
    await coord.startDraining();        // the second call is a no-op
    expect(made).toBe(1);               // the watcher is created only once
    await coord.stopDraining();
    await coord.stopDraining();          // the second call is a no-op (no exception)
  });
});

describe('IngestionCoordinator pause/resume', () => {
  it('reports isPaused true after pause() and calls close() on the injected watcher', async () => {
    const root = temporaryRoot();
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();

    await coord.pause();

    expect(coord.isPaused).toBe(true);
    expect(watch.closed).toBe(true);
  });

  it('creates no watcher when startDraining() runs while paused', async () => {
    const root = temporaryRoot();
    let made = 0;
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => { made += 1; return fakeWatch(); }, setTimer: timer.setTimer,
    });
    await coord.startDraining();
    made = 0; // exclude the initial start
    await coord.pause();

    await coord.startDraining(); // even when re-called by a failover promotion

    expect(made).toBe(0);        // no new watcher is created
  });

  it('creates the watcher again on pause() then resume() then startDraining()', async () => {
    const root = temporaryRoot();
    const watches = [fakeWatch(), fakeWatch()];
    let made = 0;
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => watches[made++]!, setTimer: timer.setTimer,
    });
    await coord.startDraining();
    await coord.pause();

    coord.resume();
    await coord.startDraining();

    expect(made).toBe(2);                 // a new watcher after resuming
    expect(coord.isPaused).toBe(false);
  });

  it('makes two consecutive pause() calls safe (idempotent)', async () => {
    const root = temporaryRoot();
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();

    await coord.pause();
    await coord.pause(); // the second call is safe too, with no exception

    expect(coord.isPaused).toBe(true);
  });

  it('drains envelopes queued in pending while paused after resume plus startDraining', async () => {
    const root = temporaryRoot();
    const watches = [fakeWatch(), fakeWatch()];
    let made = 0;
    const upsert = vi.fn().mockResolvedValue(undefined);
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watches[made++]!, setTimer: timer.setTimer,
    });
    await coord.startDraining();
    await coord.pause();
    upsert.mockClear();

    enqueueEnvelope(envelope('paused-1'), { root }); // a hook envelope fired while paused

    coord.resume();
    await coord.startDraining(); // the post-ready drain absorbs the backlog

    expect(upsert).toHaveBeenCalledTimes(1);
    await coord.stopDraining();
  });
});
