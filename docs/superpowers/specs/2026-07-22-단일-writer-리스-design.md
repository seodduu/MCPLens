# 단일 Writer 리스 — 동시 쓰기 lost-update 방지 설계

> 상태: 설계 승인안. 구현 계획(writing-plans)의 기준 문서.
> 관련: `docs/designs/2026-07-20-공식-hook-우선-수집-설계.md`(인박스 append-only 수집),
> `MCP-Lens-설계문서-v2.md`(저장소).

## 1. 문제

`LensStore`(sql.js)는 DB 전체를 메모리에 올려두고, 매 트랜잭션 커밋마다
`save()`(store.ts:110→288)로 **인메모리 DB 전체를 파일에 export→temp→rename**한다.
`open()`은 생성 시 파일을 **한 번만** 읽는다. 파일 잠금도, 행 단위 병합도 없다.

따라서 **두 개 이상의 `LensStore` 인스턴스가 같은 `~/.mcplens/lens.db`에 쓰면**,
나중에 커밋한 인스턴스가 자기 (오래된) 인메모리 스냅샷으로 파일을 통째로 덮어써
다른 인스턴스가 그 사이 넣은 행을 **소실**시킨다(lost update).

실측 확인:
- 검증 중 CLI drain이 넣은 `hook·gemini-cli`/`hook·codex` 행과 기존 `log·claude-code`
  행이, 돌고 있는 VS Code 확장의 주기적 `save()`에 덮여 사라졌다.
- `lens.db` mtime이 사용자 개입 없이 계속 갱신됨(04:15:38→04:16:20) = 살아있는 writer(확장) 확인.
- 이것이 앞선 "왜 `log-only`/`0tok`인가"의 근본 원인이다. 더 심각하게는, 두 인스턴스가
  동시에 인박스를 drain하면 한쪽이 delivery를 `processed`로 옮긴 뒤 그 DB 쓰기가 클로버되어
  **인박스에서도 DB에서도 사라지는 영구 유실**이 가능하다.

## 2. 목표 / 비목표

### 2.1 목표
- 여러 프로세스(예: VS Code 창 2개)가 떠 있어도 `lens.db`에 **실제로 쓰는 주체는 항상 하나**임을 보장한다.
- 비홀더 프로세스는 데이터를 소실시키지 않으며, 화면은 조용히 최신 상태를 보여준다(사용자 개입 불필요).
- 홀더가 죽으면 다른 프로세스가 자동으로 쓰기 역할을 인수한다.
- `네이티브 애드온 금지`·sql.js·`core에서 vscode import 금지` 제약을 지킨다.

### 2.2 비목표
- 동시 다중 writer의 병렬 쓰기 지원(선택된 방향은 단일 writer 직렬화다).
- 저장 엔진 교체(better-sqlite3 등 네이티브)나 append-only 로그로의 진실원 이전(별도 큰 작업).
- 인박스 수집 계약 변경 — 인박스는 이미 append-only 안전 큐라 그대로 둔다.

## 3. 접근 — 단일 Writer 리스

**정확히 한 프로세스만** `lens.db`를 쓸 수 있게 만든다. 그 권한을 **갱신형 리스**로 표현한다.

- **writer 모드**(리스 획득): 로그 워처·인박스 drain·스캐너 = 유일한 쓰기 주체. 하트비트로 리스 갱신.
- **read-only 모드**(리스 미획득): 아무것도 안 씀. `lens.db` 변경 감지 시 reload해 화면만 최신화.
  주기적으로 획득을 재시도해, 홀더가 죽으면 인수한다.

**핵심 불변식**: writer가 **유일한** 쓰기 주체이므로 그 "한 번 읽고 여러 번 씀"이 안전하다
(아무도 덮지 않으니 인메모리=진실). 클로버가 구조적으로 불가능해진다.

인박스가 append-only durable 큐이므로, 유일한 writer가 결국 모든 delivery를 drain한다 → **유실 없음**.

## 4. 리스 메커니즘 (core)

### 4.1 리스 원시 추출 + renew 추가

`inbox.ts`의 검증된 리스 코어(디렉토리 rename 기반 원자적 배타 생성 + 토큰 + 만료 + stale 인수:
`installLease`/`readLease`/`takeOverLease`/`acquireDeliveryLock`/`releaseDeliveryLock`)를
`packages/core/src/ingest/lease.ts`(신규)로 추출한다. inbox는 이를 재사용(동작 불변, 리팩터만).

delivery 락은 단발이라 갱신이 없지만 DB writer 리스는 장수·주기 갱신이 필요하므로 `renew`를 추가한다.

```ts
export interface Lease { token: string; expiresAt: number }

/** 원자적 배타 획득. 이미 유효한 홀더가 있으면 null. 만료된 리스는 인수한다. */
export function acquireLease(lockPath: string, ttlMs: number, now?: () => number): Lease | null;

/** 내가 여전히 홀더면 만료를 연장한 새 Lease를 반환. 인수당했으면(토큰 불일치) null. */
export function renewLease(lockPath: string, token: string, ttlMs: number, now?: () => number): Lease | null;

/** 내 토큰일 때만 해제. */
export function releaseLease(lockPath: string, token: string): void;

/** 현재 리스(만료 여부 판단용). 없으면 null. */
export function readLease(lockPath: string): Lease | null;
```

`renewLease`는 `readLease`로 현재 토큰이 내 것인지 확인 후, 내 것이면 새 `expiresAt`로 원자적 갱신,
아니면(누가 인수) `null`. TTL·갱신 주기는 확장이 정한다(§6).

### 4.2 DB writer 리스 경로

```ts
// packages/core/src/store/paths.ts (dbPath 근처)
export function dbWriterLockPath(home = os.homedir()): string {
  return join(home, '.mcplens', 'db-writer.lock');
}
```

## 5. 저장소 변경 (core)

### 5.1 쓰기 가드 (좀비 writer 차단)

`save()`가 리스 소유를 확인하도록 가드를 주입한다. 갱신 실패(인수당함) 이후의 **지연된 쓰기가
파일을 덮는 것**을 막는 마지막 방어선이다.

```ts
// LensStore
private writeGuard: (() => boolean) | null = null;
setWriteGuard(fn: (() => boolean) | null): void { this.writeGuard = fn; }

save(): void {
  if (this.filePath === ':memory:') return;
  if (this.writeGuard && !this.writeGuard()) {
    throw new StaleWriterError(); // 리스를 잃음 → 절대 쓰지 않는다
  }
  // 기존 export→temp→rename
}
```

- `StaleWriterError`는 `save()`를 부른 트랜잭션을 롤백시키고 호출부(코디네이터)로 전파된다.
- **중요**: 인박스 drain은 각 delivery를 `DB 쓰기 → markProcessed` 순으로 처리하므로,
  `save()`가 던지면 그 delivery는 `markProcessed`에 도달하지 않아 **pending으로 남는다**
  → 새 writer가 재-drain. 순서 불변식을 계획에서 명시한다.
- `writeGuard`가 없으면(가드 미설정: CLI 단독 도구, 테스트) 기존 동작.

### 5.2 read-only 새로고침

비홀더가 화면을 최신화하도록 디스크에서 다시 읽는 메서드를 추가한다.

```ts
reload(): void {
  if (this.filePath === ':memory:' || !existsSync(this.filePath)) return;
  this.db.close();
  this.db = new SQL.Database(readFileSync(this.filePath));
  // open()과 동일하게 SCHEMA/migrate는 idempotent하므로 재적용
  this.db.exec(SCHEMA); migrate(this.db);
}
```

writer는 유일한 writer라 reload가 필요 없다(자기 메모리가 진실). reload는 read-only 전용이다.

## 6. 확장 통합

### 6.1 리스 매니저

```ts
// packages/extension/src/writerLease.ts (신규)
export class WriterLeaseManager {
  // ttlMs=30_000, renewMs=10_000 (delivery 락보다 훨씬 길게 — DB writer는 장수)
  tryAcquire(): boolean;                 // 성공 시 holder
  isHolder(): boolean;                   // save writeGuard가 호출
  startHeartbeat(onLost: () => void): void; // renewMs마다 renew; 실패 시 isHolder=false + onLost()
  stop(): void;                          // 해제 + 하트비트 정지
}
```

### 6.2 activate 흐름

```
store = LensStore.open(dbPath())
lease = new WriterLeaseManager(dbWriterLockPath())

if (lease.tryAcquire()) enterWriterMode()
else enterReadOnlyMode()
```

**writer 모드:**
- `store.setWriteGuard(() => lease.isHolder())`
- 워처 시작, 코디네이터 drain, 스캐너, 백필 — 기존 쓰기 경로 전부 활성.
- `lease.startHeartbeat(onLost = downgradeToReadOnly)`.
- deactivate 시 `lease.stop()`.

**read-only 모드:**
- 쓰기 경로(워처·drain·스캐너) 미시작.
- `lens.db` mtime 폴링(3–5s) → 변하면 `store.reload()` → 트리·상태바 refresh.
  (sql.js가 temp+rename으로 저장해 `fs.watch`가 rename을 놓칠 수 있으므로 mtime 폴링이 견고하다.)
- 주기적으로(예: renewMs) `lease.tryAcquire()` 재시도 → 성공하면 `enterWriterMode()`로 승격.

**강등(onLost):** 하트비트 renew가 실패하면(누가 인수) 즉시 read-only로 전환 —
워처·코디네이터 정지, `setWriteGuard`는 그대로 두어 혹시 남은 쓰기가 `StaleWriterError`로 차단되게 함.

### 6.3 CLI·기타 도구

`/lens-audit` 등 리포트 생성 경로는 **읽기 전용**으로 store를 열고 리스를 잡지 않는다.
쓰기가 필요한 CLI(예: 독립 스캐너)는 반드시 먼저 리스를 획득한다. 계획에서 명시한다.

## 7. 엣지 케이스

| 상황 | 처리 |
|---|---|
| 홀더 정상 종료 | `stop()`이 리스 해제 → 다음 대기자가 즉시 획득 |
| 홀더 크래시(해제 못 함) | TTL 만료 후 대기자가 stale 인수(원시가 지원) |
| 인수 레이스(둘이 동시 시도) | 원자적 rename + 토큰으로 하나만 성공 |
| 좀비 writer(인수 후 지연 쓰기) | `save()`의 writeGuard가 `StaleWriterError`로 차단 |
| drain 중 강등 | 현재 delivery는 `save()` 실패로 pending 유지 → 새 writer가 재처리(유실 0) |
| 첫 실행/파일 없음 | `acquireLease`가 락 파일을 새로 만들며 획득; `open()`이 빈 DB 생성 |
| 마이그레이션 | writer 모드에서만 수행(쓰기라서). read-only의 `reload()`는 idempotent SCHEMA/migrate 재적용만 |

## 8. 테스트

전부 임시 디렉토리(고유 경로) + `:memory:`/임시 파일. 실기기 자원 없음 — 병렬 안전.

**lease.ts:**
- 두 번 `acquireLease` → 하나만 성공(배타).
- `renewLease`가 만료를 연장한다(같은 토큰).
- 인수 후 `renewLease`는 `null`(토큰 불일치).
- 만료된 리스는 다른 프로세스가 인수한다.
- `releaseLease` 후 재획득 가능.
- inbox 회귀: 추출 리팩터 후 기존 inbox 테스트 전부 통과.

**store:**
- `writeGuard`가 false면 `save()`가 `StaleWriterError`를 던진다.
- 가드 true면 정상 저장.
- `reload()`가 외부에서 바뀐 파일 내용을 반영한다(다른 store가 쓴 행을 읽어옴).

**동시성(핵심 회귀 — lost-update 재현·차단):**
- 임시 파일 하나에 store A(홀더)·store B(비홀더). B의 `save()`는 `StaleWriterError`로 거부되어
  A의 행이 보존된다. (가드 없던 옛 동작에선 유실됨 — 대비 검증)
- A가 `release` 후 B가 `tryAcquire` 성공 → B가 쓰고 A의 행도 유지(B가 reload로 최신에서 출발).

**확장:**
- activate에서 리스 획득 시 writer, 실패 시 read-only 모드로 분기(리스 매니저 목킹).
- read-only에서 파일 변경 → `reload()`+refresh 호출.

## 9. 변경 파일 맵

| 파일 | 변경 |
|---|---|
| `core/src/ingest/lease.ts` (신규) | inbox 리스 코어 추출 + `renew`/`acquireLease`/`releaseLease`/`readLease` |
| `core/src/ingest/inbox.ts` | 추출된 lease.ts 재사용(동작 불변 리팩터) |
| `core/src/store/paths.ts` | `dbWriterLockPath()` |
| `core/src/store/store.ts` | `setWriteGuard`·`save()` 가드·`StaleWriterError`·`reload()` |
| `extension/src/writerLease.ts` (신규) | `WriterLeaseManager`(획득·하트비트·강등) |
| `extension/src/extension.ts` | writer/read-only 모드 분기, mtime 폴링 reload, 승격/강등 |

`types.ts`·`schema.sql`·루트 설정 불변.

## 10. 열린 위험

- **mtime 폴링 지연**: read-only 화면 갱신이 최대 폴링 주기만큼 늦다. 드문 다중 창 시나리오에서만
  체감되며, 데이터 정확성엔 무해(읽기 전용). 필요 시 주기 단축.
- **TTL 선정**: 30s TTL/10s 갱신은 크래시 후 인수까지 최대 ~30s 공백. 이 동안 수집은 인박스에
  쌓일 뿐 유실은 없다(다음 writer가 drain). 값은 구현 중 실측으로 조정.
- **락 파일 잔존**: 비정상 종료 시 락 디렉토리가 남을 수 있으나 TTL 만료 인수로 자가 치유된다.
