# 백로그 (2026-08-05 갱신)

## v2 이월 (Wave 3 / Task 14에서 확인, 미해결)

| # | 항목 | 상태 |
|---|---|---|
| ~~V1~~ | ~~Codex zero-call 액션 후보 노출 불가~~ | **해결 (2026-08-05)** — 원인이 둘이었다. 부분일치 검색 출력의 다중 정의를 통째로 버린 것과, 서버 귀속을 수집 시점에 해서 스캔이 나중에 오면 null로 굳은 것. `docs/reports/2026-08-05-codex-load-귀속-보정/보고서.md` |
| V2 | Claude direct regret 실기기 미검증 | **범위 밖 (3차 E2E에서 확정)** — `permissions.deny`가 deny된 도구를 모델의 툴 목록에서 통째로 제거해 호출 시도 자체가 발생하지 않는다. 즉 "차단된 툴을 쓰려다 막혔다"는 신호를 Claude에서 만들 방법이 현재 없다. 회귀 스펙으로만 커버 중 |
| ~~V3~~ | ~~writer-lock reaping 디렉터리 잔존~~ | **해결 (2026-08-05)** — 4차 E2E가 본 db-writer 쪽 4개보다 실제 규모가 컸다. 진짜 누수원은 `inbox.ts`의 `releaseDeliveryLock`이 rename만 하고 rm을 안 한 것으로, 배달마다 1개씩 쌓여 실측 165개(880K)였다. rm 추가 + `sweepReapingDirs`로 옛 잔해를 드레인·리스 획득 때 회수한다 |
| ~~V4~~ | ~~`upsertClientServers`에 트랜잭션 없음~~ | **해결 (2026-08-05)** — DELETE·INSERT·`reattributePendingCodexLoads`를 `this.transaction(...)`으로 묶었다. 중간 실패 시 직전 귀속이 남는 것을 회귀 테스트로 고정 |

## 관측된 클라이언트 특성 (결함 아님, 기억용)

- **훅은 codex 코드모드 검색을 못 잡는다.** `codex-plugin/hooks/hooks.json`의 matcher가
  `^mcp__(.+?)__(.+)$`라 내장 `exec`는 안 걸리고, 어느 툴이 로드됐는지는 스크립트 출력에만
  남는다. 정의 로드 관측이 로그 전용인 구조적 이유다.
- **codex 로그 반영에 세션 종료가 필요하지 않다.** 4차 E2E는 종료해야 flush된다고 기록했으나
  2026-08-05 재확인 결과 증분 기록을 로그 워처가 실시간으로 읽는다. 4차의 관측은 그 케이스
  한정이었다.
- **codex 코드모드는 툴 인벤토리를 프롬프트에 넣지 않는다.** 실측 근거는
  `docs/decisions/2026-08-05-codex-코드모드-툴-실비용.md`.

## 로드맵

| # | 항목 | 상태 |
|---|---|---|
| ~~R1~~ | ~~설정 소스 3사 확장~~ | **완료 (Wave 7)** — claude-user/claude-project/codex/gemini 4소스 수집 + 감시 |
| ~~R2a~~ | ~~http 무인증 스캔~~ | **완료 (Wave 7)** — DeepWiki 실원격 완주로 검증 |
| ~~R2b~~ | ~~http OAuth 스캔~~ | **완료 (Wave 8)** — vercel 실 OAuth 완주 (로그인 → 툴 30개 9,146tok, 토큰 재사용, 0600) |
| R3 | 서버 지시문 토큰 채굴 | **격하 (2026-07-20, 사용자 결정)** — 로그의 `mcp_instructions_delta.addedBlocks`로 서버당 부분 비용(~60tok/세션) 추가 가능하나, ①규모 미미 ②대상(원격·내장 서버)이 조치 불가 영역이라 권고로 이어지지 않음. 툴 단위 정의는 로그에 없음(전수 조사 확정). 지시문이 큰 서버가 흔해지면 재고 |
| R4 | 세션 타임라인 웹뷰 이식 | 동결된 대시보드의 고유 기능을 VS Code 웹뷰 패널로 — 수요 확인 후 |
| R5 | OpenCode 어댑터 | 설계문서 로드맵 1번 — "어댑터 하나로 클라이언트 확장" 실증용 |

## Minor

| # | 항목 | 상태 |
|---|---|---|
| ~~M4~~ | ~~엔진 row 합집합에 loads 미포함~~ | **해결 (2026-07-19)** |
| ~~M5~~ | ~~절감량 max 선택~~ | **해결 (Wave 9 Task 30)** — 키 단위 택일(직접 우선) 합산으로 교체 |
| ~~M6~~ | ~~loadsSince 기간 무시~~ | **해결 (Wave 9 Task 30)** — sessions 조인 기간 필터. M5·M6·비교집합 불일치의 합작이 실데이터에서 saved=−20,759로 발현했던 버그 — 수정 후 실DB 검산 saved=+13,255, actual ≤ potential 성립 |
| M9 | 대시보드 `MatrixTable.tsx` 타입 에러 2건 | `ACTION_COLOR`·`ACTION_LABEL`이 `inspect` 액션 키를 안 채워 `tsc -p packages/dashboard`가 실패한다. 동결 표면이라 `npm test`·`npm run build`는 녹색이고 릴리스를 막지 않는다. 고치면 키 2개 추가로 끝난다 |
| M8 | 대시보드 리로드 동시성 + 미검증 경로 | **격하** — 표면 자체가 동결됨(`packages/dashboard/README.md`). 동결 표면의 잠재 결함으로만 기록, 수정 계획 없음 |

## 동결·취소 기록

- **대시보드 표면 동결 (2026-07-20, 사용자 결정)**: 사이드바가 상시 인터페이스 역할을 흡수.
  코드·테스트 유지(빌드는 계속 통과해야 함), 신규 기능 반영 중단. 사유·거취는
  `packages/dashboard/README.md`. "Wave 9-C 대시보드 따라잡기" 계획 취소.

## Wave 8 이월 (OAuth 하드닝 — 비차단)

| 항목 | 내용 |
|---|---|
| state 파라미터 | OAuth 콜백에 state 검증 없음 — PKCE+루프백이 1차 방어라 관례상 수용, 심층 방어로 추가 여지 |
| 재로그인 redirect_uri | 로그인마다 임시 포트가 달라 등록된 client의 redirect_uri와 불일치 가능(RFC 8252 §7.3상 서버가 포트 무시해야 정상) — vercel 1회 로그인은 성공, **재로그인 반복 케이스는 미검증** |

## ~~단일 writer 리스 Wave 1 이월 (renewLease 인수 레이스)~~ — **해결됨 (2026-07-22, Task 4.0)**

`renewLease`의 split-brain(TOCTOU) 레이스를 **정체성/만료 분리**로 재설계해 제거했다.
- **무엇을**: renew가 정체성의 원천 `owner.json`을 통째로 덮어쓰던 것을 멈추고, 만료만 담은
  별도 사이드카 `expiry.json`({token, expiresAt})을 tmp+rename으로 원자적 기록하도록 바꿨다.
  `readLease`는 token을 항상 owner.json에서 읽고, expiry.json은 그 token이 owner의 token과
  **일치할 때만** 만료를 반영한다.
- **왜 race-free**: check와 write 사이 경쟁자 B가 인수해도 (1) B의 owner.json은 renew가 안 쓰므로
  정체성 오염 불가, (2) A가 쓴 expiry.json의 token(A)은 B의 owner token과 불일치 → readLease가
  무시(B 만료도 안전), (3) write 후 재확인에서 owner token이 B → A는 null(패배). inode 가드처럼
  *탐지 후 훼손*이 아니라 **구조적으로 훼손 자체가 불가능**하다.
- **어떻게 증명**: `lease.test.ts`에 beforeWrite seam으로 인터리브드-인수를 결정론적으로 재현하는
  split-brain 실패 테스트 추가 → 재설계 후 통과. inbox 22개 포함 무회귀. lease API를 core 배럴로
  export해 `WriterLeaseManager`(TTL 30s / 갱신 10s)가 소비 가능.

## 상태바 지표 재정의 (2026-07-21) — **착수 가능**

현행 상태바(`지연 로딩으로 아낀 토큰`)는 **인센티브가 역방향**이다 — 안 쓰는 MCP 서버를
추가하면 절약 수치가 올라가고, 정리하면 내려간다. "낭비로 판단한 툴 수 + 정의 비용 합"
(`Lens: 낭비 10툴 · 15.3k`)으로 바꾼다.

선행 과제였던 정의의 클라이언트 귀속이 main에 병합돼(`49fb46b`) 차단이 풀렸다.
귀속 적용 후 실측: **claude-code 10툴 15,267tok** (gemini의 허수 92툴 34,753tok 소멸).

배경·실측·결정 근거·남은 결정사항: `docs/decisions/2026-07-21-상태바-지표-재정의.md`
(그 문서 하나로 새 세션에서 착수 가능)
