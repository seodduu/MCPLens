# Pending 워처 — 훅 봉투 실시간 drain 설계

- 작성일: 2026-07-22
- 상태: 승인 대기
- 관련: [[2026-07-20-hook-first-ingestion]] · [[2026-07-22-단일-writer-리스]]

## 1. 문제

훅 런너(Claude·Codex·Gemini)는 MCP 호출 시 봉투를 `~/.mcplens/inbox/pending/*.json`에
원자적으로 기록한다. 이 봉투를 DB(`ingest_observations`)로 옮기는 `drainInbox()`(pending→DB)는
**확장이 writer로 승격되는 순간 딱 1회**만 실행된다 (`packages/extension/src/extension.ts:208`,
`enterWriter()` 내부). `inbox/pending`을 감시해 재-drain하는 상시 트리거가 없다.

그 결과 확장 활성화 이후 세션 도중 도착한 훅 봉투는 pending에 무기한 정체된다.
반면 `LogWatcher`는 계속 돌며 클라이언트 transcript를 잡으므로, 수집 상태 패널은
훅 봉투가 실재함에도 해당 클라이언트를 **"로그 only"**(또는 transcript도 없으면 "첫 이벤트 대기")로
표시한다.

### 실측 증거 (2026-07-22)

- `inbox/pending`에 `gemini-cli`(session-start·tool-before·tool-after·session-end),
  `codex`(session-start) 봉투가 실재하나 `ingest_observations`에는 `claude-code`만 존재.
- `processed/` 마지막 갱신 04:04 = 마지막 writer 승격 시점. 이후 도착분 전부 미-drain.
- 사용자가 Gemini·Codex에서 실제 MCP를 호출하자 두 클라이언트가 "로그 only"로 바뀜 —
  훅은 정상 발화, drain만 정체됨을 확증.

## 2. 목표 / 비목표

**목표**
- writer 모드인 확장 인스턴스가 `inbox/pending`에 새 봉투가 도착하면
  짧은 지연(debounce) 후 자동으로 `drainInbox()`를 실행한다.
- 버스트(before+after 등 다수 봉투 동시 도착)를 단일 drain 호출로 코얼레싱한다.
- writer 전용: read-only 인스턴스는 감시·drain하지 않는다(단일 writer 불변식 유지).

**비목표**
- drain/정준화 로직 자체 변경 없음(`drainInbox()`·drainer·claim 락 그대로).
- 훅 런너·디코더·봉투 포맷 변경 없음.
- 폴링 주기 튜닝 UI, 사용자 설정 노출 (YAGNI).

## 3. 접근: Coordinator가 pending 워처를 소유 (A안)

inbox 관심사는 이미 `IngestionCoordinator`가 응집한다(`drainInbox`·`InboxDrainer` 소유).
따라서 워처도 coordinator에 둔다. `LogWatcher`가 확립한 core-워처 + chokidar +
주입식 `watchFactory`/`setTimer` 테스트 패턴을 그대로 미러링한다.

확장은 취약한 writer/read-only 전환 지점 **2곳만** 바꾼다:
- `enterWriter()`: 일회성 `drainInbox()` → `coordinator.startDraining()`
- `enterReadOnly()`: 새로 `coordinator.stopDraining()` 호출

### 3.1 coordinator API 추가

```ts
interface IngestionCoordinatorOptions {
  // ...기존 유지...
  /** pending 워처 팩토리 (테스트 주입). 기본은 chokidar.watch. */
  watchFactory?: (paths: string[], options: WatchOptions) => PendingWatchHandle;
  /** debounce 타이머 주입 (테스트). 기본 setTimeout. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  /** debounce 지연. 기본 50ms (LogWatcher와 동일). */
  drainDebounceMs?: number;
  /** 감시 대상 pending 디렉토리. 기본 inboxPath()+'/pending'. */
  pendingDir?: string;
}

class IngestionCoordinator {
  /** 최초 1회 즉시 drain(밀린 봉투 흡수) 후 pending 감시 시작. 멱등. */
  async startDraining(): Promise<void>;
  /** 감시 중지(chokidar close). 인플라이트 drain은 그대로 완료되게 둔다. 멱등. */
  async stopDraining(): Promise<void>;
}
```

### 3.2 워처 내부 동작

- `startDraining()`:
  1. `watching` 가드(이미 감시 중이면 no-op — 멱등, 중복 시작 방지).
  2. 즉시 `await this.drainInbox()` 1회 (활성화 이후 밀린 봉투 캐치업).
     기존 `enterWriter`의 일회성 drain을 이 안으로 흡수.
  3. `watchFactory([pendingDir], { ignoreInitial: true, ... })`로 chokidar 감시 시작.
  4. `add` 이벤트마다 `scheduleDrain()`.
- `scheduleDrain()` — **인플라이트 가드 + 트레일링 코얼레싱** (확장의
  `scheduleCollectionRefresh` 패턴 동일):
  - 이미 drain 실행 중이면 `pending=true`만 세우고 반환.
  - debounce 타이머가 이미 걸려 있으면 재사용(리셋 없이 합류).
  - 타이머 만료 → `drainInbox()` 실행 → 끝난 뒤 `pending`이 섰으면 정확히 한 번 더.
- `stopDraining()`: 타이머 해제 + `watcher.close()` + `watching=false`.
  진행 중 `drainInbox()` Promise는 중단하지 않는다(claim 락이 정합성 보장).

### 3.3 데이터 흐름

```
훅 런너 → pending/xxx.json (원자 write)
                │  chokidar 'add'
                ▼
        coordinator.scheduleDrain()  ──debounce 50ms/코얼레싱──▶ drainInbox()
                                                                    │
                                              claim → persist → complete(processed/)
                                                                    │ emit 'ingested'
                                                                    ▼
                                                    확장 refresh() → 패널 "Hook+로그"
```

## 4. 동시성·안전성

- **단일 writer 불변식**: `startDraining`은 오직 `enterWriter()`에서만 호출된다.
  강등(`enterReadOnly`) 시 `stopDraining()`으로 감시가 멈춘다. 만약 강등 경합으로
  타이머가 늦게 발화해도, `drainInbox()`의 `persist`가 `store.setWriteGuard`(리스 홀더 검사)로
  `StaleWriterError`를 던지고 확장의 `ignoreStaleWriterError`가 이를 흡수한다 — 최후 방어선 유지.
- **버스트 코얼레싱**: 한 툴 호출이 before+after 2봉투를 낳고, 여러 툴이 겹칠 수 있다.
  인플라이트 가드가 이를 단일 drain으로 접는다 — claim은 어차피 그 시점 pending 전체를 배치로 집는다.
- **부분 실패**: 기존 `drainInbox` 계약 그대로 — 한 봉투 persist 실패 시 이후 claim들을
  release하고 throw. 다음 `add` 이벤트나 다음 debounce에서 재시도된다.
- **chokidar 초기 스캔**: `ignoreInitial: true`. 밀린 봉투는 3.2-②의 즉시 drain이 담당하므로
  초기 `add` 폭주를 방지한다.
- **pending 디렉토리 부재**: 최초 봉투 전엔 디렉토리가 없을 수 있다. chokidar는 미존재 경로도
  감시 가능하나(생성 시 이벤트), 안전하게 `startDraining`에서 `mkdirSync(pendingDir, {recursive})`로
  선보장한다(확장이 이미 `dbWriterLockPath` 디렉토리에 동일 패턴 사용).

## 5. 확장 배선 변경 (extension.ts)

```ts
// enterWriter() 내부 — 기존:
//   void coordinator?.drainInbox().then(() => watcher!.backfill())...
// 변경:
    void coordinator?.startDraining()
      .then(() => watcher!.backfill())
      .then(() => { refresh(); })
      .catch(ignoreStaleWriterError);

// enterReadOnly() 내부 — 추가:
    void coordinator?.stopDraining().catch(() => {}); // 감시 중지, drain은 자연 종료
```

`coordinator?.on('ingested', refresh)`는 이미 activation당 1회 등록돼 있어,
워처가 유발한 drain의 `ingested` 이벤트가 그대로 패널을 갱신한다. 추가 배선 불필요.

`IngestionCoordinatorLike` 타입(extension.ts:30)에 `startDraining`/`stopDraining` 추가.

## 6. 테스트

**core 유닛** (`packages/core/test/ingest/`):
- 주입 `watchFactory`(가짜 emitter) + `setTimer`(수동 tick)로 결정론적 검증.
- `startDraining`이 즉시 1회 drain 후 감시를 시작한다 (밀린 봉투 흡수).
- `add` 이벤트 → debounce 후 정확히 1회 `drainInbox`.
- 버스트(연속 `add` 3회) → 단일 drain으로 코얼레싱.
- drain 인플라이트 중 도착한 `add` → 완료 후 정확히 1회 트레일링 drain.
- `stopDraining` 후 `add` 이벤트는 무시.
- `startDraining`/`stopDraining` 멱등(2회 호출 안전).

**E2E** (`packages/core/test/e2e/hook-pipeline.test.ts` 확장):
- 임시 inbox+`:memory:` DB. `startDraining` 상태에서 봉투 파일을 pending에 씀 →
  실제 chokidar `add` 발화 → DB에 관측 반영 (파일→DB 전 구간, 워처 실동작).

유닛/E2E는 픽스처 + 임시 inbox + `:memory:` DB만 사용 — 터미널 병렬 안전(CLAUDE.md 규칙).

## 7. 부수 이슈 (범위 외 — 별도 보고)

이번 설계 범위는 아니나 실측 중 발견:
- `inbox/.locks`에 누수 락 ~211개, stale `db-writer.lock.reaping-*` 잔재.
  → drain 정체와 별개의 리스/락 청소 문제. 백로그로 분리.

## 8. 영향 파일

| 파일 | 변경 |
|---|---|
| `packages/core/src/ingest/coordinator.ts` | `startDraining`/`stopDraining` + 워처·debounce 내부 추가 |
| `packages/core/src/ingest/index.ts` (export) | 필요 시 타입 export |
| `packages/extension/src/extension.ts` | `enterWriter`/`enterReadOnly` 2곳 배선, 타입 2줄 |
| `packages/core/test/ingest/*` | 신규 유닛테스트 |
| `packages/core/test/e2e/hook-pipeline.test.ts` | 워처 실동작 E2E 1건 |

공유 계약(`types.ts`·`schema.sql`) 변경 없음.
