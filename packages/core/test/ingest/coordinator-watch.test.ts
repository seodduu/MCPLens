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

// 주입식 가짜 워처: add 리스너를 수동으로 발화, ready는 실 chokidar처럼
// 비동기(마이크로태스크)로 자동 발화, close 여부 노출.
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

// 수동 타이머: setTimer 콜백을 모았다가 flush로 동기 발화 → debounce 결정론화.
function manualTimer() {
  let queue: Array<() => void> = [];
  return {
    setTimer: (cb: () => void) => { queue.push(cb); return 0 as unknown as ReturnType<typeof setTimeout>; },
    flush: () => { const q = queue; queue = []; for (const cb of q) cb(); },
    get count() { return queue.length; },
  };
}

describe('IngestionCoordinator pending watcher', () => {
  it('startDraining이 즉시 밀린 봉투를 drain한 뒤 감시를 시작한다', async () => {
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

    expect(upsert).toHaveBeenCalledTimes(1);       // 밀린 봉투 흡수
    expect(watch.closed).toBe(false);               // 감시 개시
    await coord.stopDraining();
  });

  it('ready 시점에 존재하는 봉투를 add 이벤트 없이 초기 drain으로 흡수한다(레이스 차단)', async () => {
    const root = temporaryRoot();
    // ready 이전부터 pending에 존재하는 파일(초기 스캔에서 ignoreInitial로 억제됨).
    enqueueEnvelope(envelope('present-at-ready'), { root });
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });

    await coord.startDraining();       // ready(마이크로태스크) 후 초기 drain 실행

    // add 이벤트를 전혀 발화하지 않았음에도 봉투가 흡수됨.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(timer.count).toBe(0);       // scheduleDrain(=add 경로) 미사용
    await coord.stopDraining();
  });

  it('add 이벤트가 debounce 후 정확히 1회 drain을 유발한다', async () => {
    const root = temporaryRoot();
    const upsert = vi.fn().mockResolvedValue(undefined);
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: upsert }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();       // backlog 비어 있음(upsert 0)
    upsert.mockClear();

    enqueueEnvelope(envelope('live-1'), { root });
    watch.emitAdd(join(root, 'pending', 'live-1.json'));
    timer.flush();
    await Promise.resolve();           // runDrain의 마이크로태스크 소진
    await Promise.resolve();

    expect(upsert).toHaveBeenCalledTimes(1);
    await coord.stopDraining();
  });

  it('버스트(연속 add 3회)를 단일 drain으로 코얼레싱한다', async () => {
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
    expect(timer.count).toBe(1);       // 창 하나만 열림
    timer.flush();
    await Promise.resolve(); await Promise.resolve();

    expect(upsert).toHaveBeenCalledTimes(1);
    await coord.stopDraining();
  });

  it('drain 인플라이트 중 도착한 add를 완료 후 정확히 1회 트레일링 drain한다', async () => {
    const root = temporaryRoot();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    // 첫 drain의 upsert를 gate로 붙잡아 인플라이트 상태를 결정론적으로 만든다.
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
    await coord.startDraining();       // backlog 비어 있음(upsert 0)

    // 1) 첫 봉투 → drain 착수, upsert가 gate에서 블록(drainInFlight=true).
    enqueueEnvelope(envelope('flight-1'), { root });
    watch.emitAdd(join(root, 'pending', 'flight-1.json'));
    timer.flush();
    await Promise.resolve();           // runDrain이 drainInbox까지 진입

    // 2) 인플라이트 중 두 번째 봉투 도착 → drainQueued만 세워짐(즉시 drain 없음).
    enqueueEnvelope(envelope('flight-2'), { root });
    watch.emitAdd(join(root, 'pending', 'flight-2.json'));
    timer.flush();
    await Promise.resolve();
    expect(calls).toBe(1);             // 아직 첫 drain 하나만 진행 중

    // 3) gate 해제 → 첫 drain 완료 → 트레일링으로 정확히 한 번 더 스케줄.
    release();
    while (timer.count === 0) await new Promise((r) => setTimeout(r, 0));
    timer.flush();
    while (upsert.mock.calls.length < 2) await new Promise((r) => setTimeout(r, 0));

    expect(upsert).toHaveBeenCalledTimes(2); // flight-1 + 트레일링 flight-2, 코얼레싱 초과 없음
    await coord.stopDraining();
  });

  it('stopDraining 후의 add는 무시되고 워처가 닫힌다', async () => {
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

  it('start/stop이 멱등하다', async () => {
    const root = temporaryRoot();
    const watches = [fakeWatch(), fakeWatch()];
    let made = 0;
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => watches[made++]!, setTimer: manualTimer().setTimer,
    });
    await coord.startDraining();
    await coord.startDraining();        // 두 번째는 no-op
    expect(made).toBe(1);               // 워처 한 번만 생성
    await coord.stopDraining();
    await coord.stopDraining();          // 두 번째는 no-op(예외 없음)
  });
});

describe('IngestionCoordinator pause/resume', () => {
  it('pause() 후 isPaused가 true이고 주입된 워처의 close()가 호출된다', async () => {
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

  it('중지 중 startDraining()은 워처를 만들지 않는다', async () => {
    const root = temporaryRoot();
    let made = 0;
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => { made += 1; return fakeWatch(); }, setTimer: timer.setTimer,
    });
    await coord.startDraining();
    made = 0; // 초기 시작분 제외
    await coord.pause();

    await coord.startDraining(); // failover 재승격 등으로 재호출되어도

    expect(made).toBe(0);        // 워처는 새로 만들어지지 않는다
  });

  it('pause() → resume() → startDraining()이면 워처가 다시 생성된다', async () => {
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

    expect(made).toBe(2);                 // 재개 후 새 워처 생성
    expect(coord.isPaused).toBe(false);
  });

  it('pause() 2회 연속 호출이 안전하다(멱등)', async () => {
    const root = temporaryRoot();
    const watch = fakeWatch();
    const timer = manualTimer();
    const coord = new IngestionCoordinator({
      store: { upsertObservation: vi.fn().mockResolvedValue(undefined) }, inbox: { root },
      watchFactory: () => watch, setTimer: timer.setTimer,
    });
    await coord.startDraining();

    await coord.pause();
    await coord.pause(); // 두 번째 호출도 예외 없이 안전

    expect(coord.isPaused).toBe(true);
  });

  it('중지 중 pending에 쌓인 봉투가 resume+startDraining 후 drain된다', async () => {
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

    enqueueEnvelope(envelope('paused-1'), { root }); // 중지 중 발화한 훅 봉투

    coord.resume();
    await coord.startDraining(); // ready-후 1회 drain이 밀린 봉투를 흡수

    expect(upsert).toHaveBeenCalledTimes(1);
    await coord.stopDraining();
  });
});
