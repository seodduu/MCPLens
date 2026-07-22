# Pending 워처 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** writer 모드 확장이 `~/.mcplens/inbox/pending`에 도착한 훅 봉투를 debounce 후 자동으로 DB에 drain하도록, `IngestionCoordinator`에 pending 워처를 추가한다.

**Architecture:** `IngestionCoordinator`가 `startDraining()`/`stopDraining()`를 노출한다. `startDraining()`은 즉시 1회 `drainInbox()`(밀린 봉투 흡수) 후 pending 디렉토리를 chokidar로 감시하고, `add` 이벤트를 인플라이트 가드 + 트레일링 코얼레싱으로 debounce해 `drainInbox()`를 재호출한다. 확장은 `enterWriter()`/`enterReadOnly()` 두 지점만 배선한다. `LogWatcher`의 주입식 `watchFactory`/`setTimer` 패턴을 그대로 미러링해 결정론적 유닛테스트가 가능하다.

**Tech Stack:** TypeScript(ESM), chokidar(기존 의존성), vitest, VS Code 확장 API.

**설계 문서:** `docs/superpowers/specs/2026-07-22-pending-watcher-design.md`

## Global Constraints

- core에서 `vscode` import 금지. DB 경로는 `os.homedir()` + `path.join()`(`~` 하드코딩 금지).
- 공유 계약 파일 수정 금지: `packages/core/src/types.ts`, `packages/core/src/store/schema.sql`.
- 유닛/E2E는 픽스처 + 임시 inbox(`mkdtemp`) + `:memory:` DB만 사용(터미널 병렬 안전).
- 기존 `drainInbox()`·`InboxDrainer`·claim 락 로직 변경 금지 — 재호출만 추가.
- 파일 모드/보안: pending 디렉토리 생성은 반드시 기존 `inboxPaths()`(0700 secureDirectory) 경유.

---

## 터미널 분배 · 웨이브 분석

**의존성 그래프**
```
Task 1 (core: startDraining/stopDraining + 유닛테스트)   ← 계약 정의, 모두의 선행
   ├─▶ Task 2 (extension 배선)        ┐ 서로 파일 disjoint
   └─▶ Task 3 (E2E: 실 chokidar)      ┘ (extension.ts vs e2e 테스트)
```

- **Wave 1:** Task 1 — 신규 API 계약을 정의하므로 반드시 먼저 완료·머지.
- **Wave 2:** Task 2 + Task 3 — 서로 다른 파일만 건드리고 둘 다 Task 1 API만 소비. 병렬 가능.

**터미널 결정: 단일 터미널 = worktree 1개 = 브랜치 `feat/pending-watcher`.**
근거: Wave 2의 두 태스크는 파일이 겹치지 않지만 **둘 다 Task 1 머지 이후에야** 시작 가능하고, 전체 변경은 3파일 규모다. Wave 2를 별도 worktree/브랜치 2개로 쪼개면 브랜치·머지·교차리뷰 오버헤드가 이득(2파일 병렬)보다 크다. 따라서 한 브랜치에서 Task 1 완료 → Task 2·Task 3을 (subagent-driven-development로) **동일 세션 내 병렬 서브에이전트**로 디스패치한다(파일 disjoint라 안전). 별도 터미널 분할은 하지 않는다.

**모델 배분(서브에이전트 스폰 시 `model`):**
| Task | 성격 | model |
|---|---|---|
| Task 1 | core, 사양 명확(계획에 코드 있음) | **sonnet** |
| Task 2 | 확장 배선 2지점, 명확 | **sonnet** |
| Task 3 | E2E — 실 chokidar 타이밍/폴링 디버깅 필요 | **opus** |

오케스트레이터 세션(리뷰·머지 게이트): opus.

### 터미널 실행 프롬프트 (그대로 붙여넣기)

```
docs/superpowers/plans/2026-07-22-pending-watcher.md 를 subagent-driven-development로 실행해줘.
브랜치 feat/pending-watcher 에서 작업. Wave 1(Task 1)을 sonnet 서브에이전트로 먼저 실행·리뷰·커밋한 뒤,
Wave 2(Task 2=sonnet, Task 3=opus)를 파일이 겹치지 않으니 병렬 서브에이전트로 디스패치해.
각 태스크는 자기 Files 목록 밖 파일을 건드리지 말고, 계약 파일(types.ts·schema.sql)은 손대지 마.
매 태스크 끝에 npx vitest run 으로 초록 확인 후 커밋.
```

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `packages/core/src/ingest/coordinator.ts` | pending 워처 소유 + debounce/코얼레싱 + start/stop | 수정 |
| `packages/core/test/ingest/coordinator-watch.test.ts` | 워처 유닛테스트(주입식, 결정론) | 신규 |
| `packages/extension/src/extension.ts` | `enterWriter`/`enterReadOnly` 배선, Like 타입 | 수정 |
| `packages/core/test/e2e/hook-pipeline.test.ts` | 실 chokidar 파일→DB E2E 1건 | 수정 |

`IngestionCoordinator`는 이미 `packages/core/src/index.ts:5`에서 `export * from './ingest/coordinator.js'`로 최상위 재노출됨 — 확장의 `require('@mcp-lens/core').IngestionCoordinator` 그대로 동작. 신규 export 불필요.

---

## Task 1: Coordinator에 pending 워처 추가

**Files:**
- Modify: `packages/core/src/ingest/coordinator.ts`
- Test: `packages/core/test/ingest/coordinator-watch.test.ts` (신규)

**Interfaces:**
- Consumes: `inboxPaths(opts)` (from `./inbox.js`) → `{ pending, ... }`, 호출 시 디렉토리 생성. 기존 `this.drainInbox(): Promise<{ingested, parseErrors}>`.
- Produces:
  - `IngestionCoordinator.startDraining(): Promise<void>` — 멱등. 즉시 1회 drain 후 pending 감시 시작.
  - `IngestionCoordinator.stopDraining(): Promise<void>` — 멱등. 타이머 해제 + 워처 close.
  - 신규 옵션 `watchFactory`, `setTimer`, `drainDebounceMs`(기본 50).
  - 신규 이벤트 `emit('drain-error', error)` — 워처 유발 drain 실패 시(확장이 StaleWriterError 흡수).
  - 타입 `PendingWatchHandle = { on(event: 'add', listener: (path: string) => void): PendingWatchHandle; close(): Promise<void> | void; }`.

- [ ] **Step 1: 실패 테스트 작성**

`packages/core/test/ingest/coordinator-watch.test.ts` 생성:

```ts
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

// 주입식 가짜 워처: add 리스너를 수동으로 발화, close 여부 노출.
function fakeWatch() {
  const listeners: Array<(p: string) => void> = [];
  let closed = false;
  const handle = {
    on(_event: 'add', listener: (p: string) => void) { listeners.push(listener); return handle; },
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run packages/core/test/ingest/coordinator-watch.test.ts`
Expected: FAIL — `coord.startDraining is not a function`.

- [ ] **Step 3: coordinator.ts 구현**

`packages/core/src/ingest/coordinator.ts` 상단 import에 추가:

```ts
import chokidar, { type WatchOptions } from 'chokidar';
```
그리고 기존 `import type { ClaimedEnvelope, InboxOptions } from './inbox.js';`를 다음으로 교체:
```ts
import { inboxPaths, type ClaimedEnvelope, type InboxOptions } from './inbox.js';
```

파일 상단(클래스 밖)에 타입 추가:
```ts
type TimerHandle = ReturnType<typeof setTimeout>;
export type PendingWatchHandle = {
  on(event: 'add', listener: (path: string) => void): PendingWatchHandle;
  close(): Promise<void> | void;
};
```

`IngestionCoordinatorOptions`에 필드 추가:
```ts
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
```

클래스 필드 추가(기존 `transactionStore` 아래):
```ts
  private readonly watchFactory: (paths: string[], options: WatchOptions) => PendingWatchHandle;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly drainDebounceMs: number;
  private pendingWatcher: PendingWatchHandle | null = null;
  private drainScheduled = false;
  private drainInFlight = false;
  private drainQueued = false;
```

생성자 본문 끝에 추가:
```ts
    this.watchFactory = options.watchFactory
      ?? ((paths, watchOptions) => chokidar.watch(paths, watchOptions) as unknown as PendingWatchHandle);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.drainDebounceMs = options.drainDebounceMs ?? 50;
```

클래스에 메서드 추가(`drainInbox` 아래):
```ts
  /** 즉시 1회 drain(밀린 봉투 흡수) 후 pending 디렉토리 감시를 시작한다. 멱등. */
  async startDraining(): Promise<void> {
    if (this.pendingWatcher) return;
    const pendingDir = inboxPaths(this.options.inbox ?? {}).pending; // 디렉토리 생성 보장
    await this.drainInbox();
    this.pendingWatcher = this.watchFactory([pendingDir], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });
    this.pendingWatcher.on('add', () => this.scheduleDrain());
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run packages/core/test/ingest/coordinator-watch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: 회귀 확인 — 기존 coordinator·inbox·E2E 테스트**

Run: `npx vitest run packages/core/test/ingest/ packages/core/test/e2e/hook-pipeline.test.ts`
Expected: PASS (전부 초록 — 기존 계약 무변경).

- [ ] **Step 6: 커밋**

```bash
git add packages/core/src/ingest/coordinator.ts packages/core/test/ingest/coordinator-watch.test.ts
git commit -m "feat(core): IngestionCoordinator에 pending 워처(start/stopDraining) 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 확장 배선 (enterWriter/enterReadOnly)

**Files:**
- Modify: `packages/extension/src/extension.ts:30-34`(Like 타입), `:200-202`(리스너), `:208`(enterWriter), `:230-242`(enterReadOnly)

**Interfaces:**
- Consumes: Task 1의 `coordinator.startDraining()`, `coordinator.stopDraining()`, `coordinator.on('drain-error', ...)`.
- Produces: (없음 — 배선만)

> ⚠️ 확장에는 자동화된 테스트 대신 typecheck + 수동 스모크가 게이트다. `vscode` import 규칙상 core 유닛으로 커버 불가한 배선이므로 typecheck·빌드·Reload 스모크로 검증한다.

- [ ] **Step 1: `IngestionCoordinatorLike` 타입 확장**

`packages/extension/src/extension.ts:30-34`를 다음으로 교체:
```ts
type IngestionCoordinatorLike = {
  drainInbox(): Promise<unknown>;
  startDraining(): Promise<void>;
  stopDraining(): Promise<void>;
  on(event: 'ingested' | 'receipt' | 'drain-error', listener: (arg?: unknown) => void): unknown;
  pause?: () => void | Promise<void>;
};
```

- [ ] **Step 2: drain-error 리스너 등록(activation당 1회)**

`packages/extension/src/extension.ts:200-202` 블록에 한 줄 추가:
```ts
  coordinator?.on('ingested', refresh);
  coordinator?.on('receipt', refresh);
  coordinator?.on('drain-error', ignoreStaleWriterError); // 강등 경합 중 stray drain 흡수
  watcher!.on('ingested', refresh);
```
(`ignoreStaleWriterError`는 이미 `:193`에 정의됨.)

- [ ] **Step 3: enterWriter의 일회성 drain을 startDraining으로 교체**

`packages/extension/src/extension.ts:208-211`:
```ts
    void coordinator?.drainInbox()
      .then(() => watcher!.backfill()) // 시작 시 밀린 세션 따라잡기 (기능 2)
      .then(() => { refresh(); })
      .catch(ignoreStaleWriterError);
```
를 다음으로 교체:
```ts
    void coordinator?.startDraining()  // 즉시 1회 drain + pending 상시 감시
      .then(() => watcher!.backfill()) // 시작 시 밀린 세션 따라잡기 (기능 2)
      .then(() => { refresh(); })
      .catch(ignoreStaleWriterError);
```

- [ ] **Step 4: enterReadOnly에서 stopDraining 호출**

`packages/extension/src/extension.ts:233`:
```ts
    stopping = watcher?.stop(); // 쓰기 경로 정지: 워처를 멈춘다. 코디네이터 drain은 호출하지 않는다.
```
바로 아래에 추가:
```ts
    void coordinator?.stopDraining().catch(() => {}); // pending 감시 중지(인플라이트 drain은 자연 종료)
```

- [ ] **Step 5: 확장 typecheck·빌드**

Run: `npm run typecheck -w mcp-lens && npm run build -w mcp-lens`
Expected: 에러 없음.

- [ ] **Step 6: 확장 유닛 스위트 회귀**

Run: `npx vitest run packages/extension/test/`
Expected: PASS (배선 변경이 기존 테스트를 깨지 않음).

- [ ] **Step 7: 커밋**

```bash
git add packages/extension/src/extension.ts
git commit -m "feat(extension): writer 승격 시 pending 상시 감시 배선(start/stopDraining)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: E2E — 실 chokidar 파일→DB 검증

**Files:**
- Modify: `packages/core/test/e2e/hook-pipeline.test.ts` (신규 테스트 1건 append)

**Interfaces:**
- Consumes: Task 1의 `coordinator.startDraining()`/`stopDraining()`, 실 `chokidar`(주입 없음), `enqueueEnvelope`, `LensStore`, `IngestionCoordinator`.
- Produces: (없음)

> 이 태스크는 실 chokidar의 비동기 `add` 발화 타이밍에 의존하므로 폴링+타임아웃으로 안정화한다(가짜 워처 아님). 그래서 opus 담당.

- [ ] **Step 1: 실패(미구현) E2E 테스트 작성**

`packages/core/test/e2e/hook-pipeline.test.ts` 파일 끝의 마지막 `});`(describe 종료) **직전**에 새 `it` 추가. 파일 상단 import에 `enqueueEnvelope`가 이미 있으면 재사용(있음). 없으면 추가.

```ts
  it('startDraining이 실 chokidar로 pending 파일을 감지해 DB에 반영한다', async () => {
    const root = temporaryRoot();
    const store = await LensStore.open(':memory:');
    const coordinator = new IngestionCoordinator({ store, inbox: { root } });
    try {
      await coordinator.startDraining(); // 감시 시작(backlog 없음)

      const env: HookEnvelope = {
        schemaVersion: 1, deliveryId: 'native:e2e-watch-1', client: 'codex',
        phase: 'tool-after', receivedAt: NOW, externalSessionId: 's-watch',
        externalTurnId: 't-watch', externalCallId: 'native:e2e-watch-1',
        transcriptPath: null, serverName: 'github', toolName: 'get_issue',
        observedAt: NOW, durationMs: 7, isError: false, inputFingerprint: null,
      };
      enqueueEnvelope(env, { root }); // pending에 실제 파일 write → chokidar 'add'

      // 실 워처 발화까지 폴링(최대 3초).
      const deadline = Date.now() + 3_000;
      let rows = 0;
      while (Date.now() < deadline) {
        rows = store.observationCount(); // ↓ Step 2에서 헬퍼 확인
        if (rows >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(rows).toBe(1);
    } finally {
      await coordinator.stopDraining();
      store.close();
    }
  });
```

- [ ] **Step 2: DB 관측 카운트 헬퍼 확인/대체**

먼저 `LensStore`에 관측 수를 세는 접근자가 있는지 확인:

Run: `grep -nE "observationCount|ingest_observations|allObservations|countObservations" packages/core/src/store/store.ts`

- 이미 카운트/조회 메서드가 있으면 그걸 사용하도록 위 테스트의 `store.observationCount()` 줄을 교체.
- 없으면, 테스트 내부에서 직접 SQL로 세도록 교체(신규 프로덕션 API 추가 금지 — YAGNI):
  ```ts
  // store 내부 db 접근이 불가하면, 같은 :memory: 대신 임시 파일 DB를 열고
  // better-sqlite3로 직접 count. 단, 프로젝트 기존 E2E가 store 헬퍼를 쓰면 그 패턴을 따를 것.
  ```
  실제 존재하는 조회 메서드(예: `store.callsSince()` 또는 관측 전용 카운트)를 grep으로 찾아 그 반환에서 개수를 도출한다. 기존 `hook-pipeline.test.ts`가 관측을 검증하는 방식(파일 내 다른 `it`들)을 그대로 모방하는 것이 가장 안전하다.

- [ ] **Step 3: 테스트 실행**

Run: `npx vitest run packages/core/test/e2e/hook-pipeline.test.ts`
Expected: PASS (신규 1건 포함). 실 chokidar가 3초 내 `add`를 발화해 관측 1건 적재.

- [ ] **Step 4: 전체 core 스위트 회귀**

Run: `npx vitest run packages/core/`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add packages/core/test/e2e/hook-pipeline.test.ts
git commit -m "test(core): pending 워처 실 chokidar 파일→DB E2E

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 최종 검증 (오케스트레이터, 머지 전)

- [ ] **전체 테스트**: `npm test` → 전부 초록.
- [ ] **전체 빌드**: `npm run build` → core·cli·extension·dashboard.
- [ ] **패키지 검증**(런타임 번들 무관하지만 회귀 확인): `node scripts/verify-hook-packages.mjs` 상태 확인(별건 stale 번들 이슈는 이 PR 범위 아님 — 설계 §7).
- [ ] **실기기 스모크**: VS Code `Developer: Reload Window` → 확장 재활성화 → Gemini/Codex 새 세션에서 MCP 호출 → 봉투가 **실시간으로** DB 반영되고 패널이 "Hook+로그"로 바뀌는지 확인(설치 후 세션 도중 도착분이 즉시 drain되는지). `docs/SMOKE.md`에 기록.

---

## Self-Review 결과

- **스펙 커버리지**: 설계 §3.1(API)→Task1, §3.2(워처 동작·코얼레싱)→Task1 Step3+테스트, §4(단일 writer/StaleWriter)→Task1 `runDrain` 가드 + Task2 drain-error 리스너, §5(확장 배선)→Task2, §6(테스트 6종)→Task1(유닛 6건: backlog·debounce·버스트·**인플라이트 트레일링**·stop 무시·멱등)·Task3(E2E). §7(락 누수)은 명시적 범위 외로 최종 검증에 기록만. **누락 없음.**
- **placeholder**: 없음(모든 코드 블록 실체 포함). Task3 Step2만 "grep로 실제 헬퍼 확인" 분기 — 실측 결과 `store.observationCount()`(store.ts:45)가 이미 존재하므로 신규 API 없이 그대로 사용 가능.
- **타입 일관성**: `startDraining`/`stopDraining`/`PendingWatchHandle`/`drain-error`가 Task1 정의 ↔ Task2 소비에서 철자·시그니처 일치. `inboxPaths().pending` 반환 사용 일치.
- **코드 참조 실측(2026-07-22)**: `IngestionCoordinator extends EventEmitter`(coordinator.ts:44) — `emit('drain-error')` 베이스 변경 불요. `inboxPaths()`가 `secureDirectory`로 pending 0700 생성 — §Global Constraints 만족. extension.ts 라인(:30 Like·:193 ignoreStaleWriterError·:208 drainInbox·:230/:233 enterReadOnly) 전부 일치. import 교체 대상(coordinator.ts:5)도 계획과 동일.
