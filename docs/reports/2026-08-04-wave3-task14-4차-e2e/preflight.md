# Wave 3 / Task 14 4차 실환경 E2E: read-only preflight 보고서 (재실행분)

- 작성 시각: 로컬 2026-08-04 02:2x 관측
- worktree: `/Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/worktrees/mcplens-task-14-e2e-4th`
- 브랜치: `verify/v2-e2e-4th` / HEAD `aca02b0`
- **판정: `status: BLOCKED`**
  - Claude 경로는 준비 완료다.
  - Codex 경로는 **후보가 구조적으로 존재할 수 없음**을 이번에 확정했다. 이것이 지난 회차
    보고서와 달라진 핵심이며, 이번 회차의 Codex 계획을 그대로 실행하면 목표에 도달하지 못한다.

이 회차에서도 어떤 파일도 수정하지 않았다. 공유 DB는 `sqlite3 -readonly`로 열거나
스크래치패드로 복사한 사본을 통해서만 읽었다. 시작과 끝에서 `lens.db`의 mtime과 크기가
동일함을 확인했다 (`1785777814 / 8167424` 불변, 스크립트 자체도 `SRC_UNCHANGED true` 출력).
실제 MCP 서버는 기동하지 않았다. 설정 파일의 원문·시크릿·환경변수 값은 이 문서에 옮기지
않았고, 섹션 이름과 불리언 플래그만 확인했다.

---

## 1. 검증 명령 결과

| # | 명령 | 결과 |
|---|---|---|
| 1 | `npm run build` | 통과. core / dashboard / extension 전부 빌드. `dist/extension.js` 6.6MB, claude·codex 마켓플레이스와 gemini 확장 번들 생성 |
| 2 | `npm test` | 통과. **92 파일 / 982 테스트 전원 green** (5.27s) |
| 3 | `npx tsc --noEmit -p packages/core/tsconfig.json` | 통과 (exit 0) |
| 4 | `npx tsc --noEmit -p packages/extension/tsconfig.json` | 통과 (exit 0) |
| 5 | `git diff --check` | 통과 (exit 0) |
| 6 | 회귀 감시 8개 스펙 | 통과. **8 파일 / 100 테스트 green** (0.58s) |

6번 대상: `scanDecision`(10), `autoScan`(2), `collectionHealth`(18), `claudeAttempt`(12),
`actions/codex`(7), `store`(14), `globalActionCommand`(13), `codex/adapter`(24).

빌드·테스트·타입체크 계층에는 적신호가 없다.

---

## 2. 환경이 지난 회차 보고서 이후 달라진 점

먼저 이것부터 적는다. 지난 보고서를 그대로 신뢰하면 판단이 틀어지는 항목들이다.

| 항목 | 지난 보고서 | 지금 |
|---|---|---|
| `lens.db` 크기 | 8,069,120 | **8,167,424** (mtime 02:23) |
| 스키마 7개 테이블 부재 | `server_identities` 등 7개 없음 | **전부 생성돼 있다** (행은 전부 0) |
| rollout 유효값 | `shadow` (설정 키 없음) | **`codex-beta`** (아래 5절) |
| VS Code 프로세스 | 없음 | **격리된 확장 개발 호스트 1개가 실행 중** |
| inbox pending | 0 | **3** |
| `ingest_observations` | 3895 | 3900 |
| codex `lastEventAt` | 2026-08-03T14:55:03Z | **2026-08-03T17:17:03Z** |

즉 지난 preflight 이후 확장 개발 호스트가 한 번 떠서 스키마를 만들고 관측을 더 받았다.
데이터 적재(스캔·분석·액션)는 아직 하나도 일어나지 않았다.

---

## 3. 클라이언트 설치·신뢰 상태

### Claude Code

- 플러그인: `claude plugin list` 결과 `mcp-lens@mcplens` v0.1.0, scope user, **enabled**.
- 마켓플레이스: `~/.claude/settings.json`에 `enabledPlugins["mcp-lens@mcplens"] = true`,
  `extraKnownMarketplaces.mcplens`가 `~/.mcplens/claude-marketplace` 디렉터리를 가리킨다.
- 훅 경로: `settings.json`의 사용자 `hooks` 블록에는 mcplens 관련 항목이 없다.
  훅은 전부 플러그인 경유이며 이것이 정상 상태다.
- 신뢰·실사용 증거: `~/.claude.json`의 `pluginUsage["mcp-lens@mcplens"]`가
  `usageCount 2103`, `lastUsedNumStartups 297`, `lastUsedAt`이 지금 세션과 같은 시각이다.
  별도 신뢰 프롬프트가 걸려 있지 않다.
- 런타임 신선도: `~/.mcplens/claude-marketplace`와 이번 빌드 산출물
  `packages/extension/dist/claude-marketplace`가 `diff -rq`에서 차이 0.
  `~/.mcplens/installed-runtime.json`의 `claude-code` 스탬프도 동일.
- **판정: 설치 완료, 신뢰 완료, 런타임 최신.**

### Codex

- `~/.codex/config.toml`에 `[plugins."mcp-lens@mcplens"] enabled = true`.
- `[features] plugin_hooks = true`.
- 훅 신뢰: `[hooks.state."mcp-lens@mcplens:hooks/hooks.json:<phase>:0:0"]` 4개
  (`pre_tool_use`, `post_tool_use`, `session_start`, `stop`)가 모두 `trusted_hash`를
  가지고 있고 `session_start`는 `enabled = true`까지 명시돼 있다. 과거 로컬 마켓플레이스
  시절 항목(`mcp-lens@mcplens-local:...`) 4개도 남아 있다.
- 등록된 MCP 서버: `node_repl`, `computer-use`, `openaiDeveloperDocs` 세 개다.
  **`lenstest2`는 현재 등록돼 있지 않다.** (과거 codex 관측에 `lenstest2` 호출이 남아
  있으므로 예전에는 등록돼 있다가 제거된 것으로 보인다.)
- 런타임 신선도: `~/.mcplens/codex-marketplace`와 빌드 산출물 `diff -rq` 차이 0, 스탬프 동일.
- **판정: 설치 완료, 신뢰 완료, 런타임 최신.**

---

## 4. 수집 건강도와 그 판정 근거

`LensStore.collectionHealthByClient()`를 이번 빌드의 dist 코드로 DB 사본에 대해 실행했다.
이 함수는 `ingest_observations` **전 기간**을 입력으로 쓰며 창을 자르지 않는다.

| 클라이언트 | 건강도 | consecutiveMisses | consecutiveMatches | waitingForCorrelation | lastEventAt |
|---|---|---|---|---|---|
| claude-code | `healthy` | 0 | 2 | 0 | 2026-08-03T17:23:34Z |
| gemini-cli | `healthy` | 0 | 3 | 0 | 2026-07-23T05:43:15Z |
| codex | **`degraded`** | **41** | 0 | 0 | 2026-08-03T17:17:03Z |

### source / phase 분포 (전 기간, 총 3900건)

| client | source | phase | 건수 | 마지막 관측 |
|---|---|---|---|---|
| claude-code | hook | session-start | 265 | 2026-08-03T17:23:30Z |
| claude-code | hook | session-end | 230 | 2026-08-03T17:23:34Z |
| claude-code | hook | tool-before | 958 | 2026-08-03T11:14:43Z |
| claude-code | hook | tool-after | 922 | 2026-08-03T11:14:46Z |
| claude-code | hook | tool-failure | 26 | 2026-08-01T11:18:11Z |
| claude-code | log | tool-before | 324 | 2026-08-03T16:58:04Z |
| claude-code | log | tool-after | 472 | 2026-08-03T11:14:43Z |
| claude-code | log | tool-failure | 23 | 2026-08-03T10:43:17Z |
| codex | hook | session-start | 75 | 2026-08-03T17:17:00Z |
| codex | hook | turn-stop | 274 | 2026-08-03T17:17:03Z |
| codex | hook | tool-before | 79 | 2026-08-03T10:53:09Z |
| codex | hook | tool-after | 71 | 2026-08-03T10:52:58Z |
| codex | log | tool-before | 47 | 2026-08-03T14:49:31Z |
| codex | log | tool-after | 118 | 2026-08-03T14:55:03Z |
| codex | log | tool-failure | 2 | 2026-08-03T10:40:24Z |
| gemini-cli | hook | 4단계 합 | 11 | 2026-07-23T05:43:15Z |
| gemini-cli | log | tool-after | 3 | 2026-07-22T07:50:02Z |

correlationKey 신뢰도 분포: claude-code high 2397 / medium 495 / low 328,
codex high 270 / medium 349 / low 47, gemini-cli medium 11 / low 3.

### codex degraded의 근거와 회복 가능성

- 남은 41연속 miss는 로직 결함이 아니라 **훅이 붙지 않은 세션에서 log만 들어온 구간** 때문이다.
  마지막 codex log 완료 관측은 14:55의 `lenstest2/get_weather` 2건이고 짝이 되는 hook이 없다.
- **회복 경로는 살아 있다.** 가장 최근 codex 세션 `019fc8a0`(17:17)은 `session-start` hook과
  `turn-stop` hook을 정상적으로 남겼다. 즉 **지금 방식으로 codex TUI 세션을 띄우면 훅은
  붙는다.** 그 세션에서 MCP 호출이 없었기 때문에 match가 생기지 않았을 뿐이다.
- `MATCHES_TO_RECOVER = 2`이고 4차 보정으로 `HOOK_COVERAGE_PHASES`에 `tool-before`가
  포함됐으므로, 훅이 붙은 세션에서 MCP 호출을 2회 성사시키면 degraded가 풀린다.
  **이 부분에 한해서는 사용자 계획이 타당하고 실현 가능하다.**
- 반대로 훅이 붙지 않는 실행 경로로 호출하면 miss가 41에서 더 늘어난다.

### 건강도가 액션을 막는다

`packages/core/src/dependency/eligibility.ts:31-33`은 `collectionHealth`가 `healthy` 또는
`log-only`가 아니면 `collection-health-unsafe`를 붙인다. 지금 상태로는 codex 전역 액션이
대상 툴과 무관하게 이 게이트에서 막힌다.

---

## 5. config-derived identity 충돌 유무

`collectAllSpecs()`를 dist에서 실행해 설정 파일만 읽어 판정했다.

- 병합된 서버 9개: `lenstest`, `lenstest2`, `deepwiki`, `notion`, `github`, `vercel`,
  `figma`, `node_repl`, `tiny`. skip 1개: `computer-use`(transport 판별 불가).
- identity 행 **11개**, `conflictState`가 `clear`가 아닌 행 **0개**.

| 서버 | 클라이언트 | transport | conflictState |
|---|---|---|---|
| lenstest | claude-code | stdio | clear |
| lenstest2 | claude-code | stdio | clear |
| deepwiki | claude-code | http | clear |
| notion | claude-code | http | clear |
| github | claude-code | http | clear |
| vercel | claude-code | http | clear (2행, 엔드포인트 해시 동일) |
| figma | claude-code | http | clear |
| node_repl | codex | stdio | clear |
| notion | gemini-cli | http | clear |
| tiny | gemini-cli | stdio | clear |

- **충돌 0건.**
- 다만 `server_identities` 테이블은 **존재하지만 행이 0개**다.
  `globalActionCommand.identityIsSafe`(`packages/extension/src/globalActionCommand.ts:40-48`)는
  `rows.length > 0`을 요구하므로, **스캔으로 identity를 적재하기 전까지는 모든 전역 액션이
  `identity-not-clear`로 막힌다.** 설정상 충돌이 없다는 것과 액션이 열린다는 것은 다르다.

---

## 6. rollout 단계의 현재 값

- 설정 키: `mcplens.dependencyAnalysis.rollout` (extension `package.json` 기본값 `shadow`).
- 일반 VS Code 사용자 설정(`~/Library/Application Support/Code/User/settings.json`)에는
  이 키가 **없다**.
- 그러나 실행 중인 확장 개발 호스트는 격리된 `--user-data-dir=/tmp/mcplens-4th-udd`를 쓰고,
  그 안의 `User/settings.json`에 **`"mcplens.dependencyAnalysis.rollout": "codex-beta"`**가
  이미 들어 있다.
- **따라서 이번 회차에서 실제로 적용되는 rollout 값은 `codex-beta`다.** claude-code와 codex
  양쪽 액션 UI가 rollout 게이트에서는 열려 있다.
- 함의: 지난 보고서의 mutation 순서 2번("rollout을 올린다")은 **이미 완료된 상태**이며,
  일반 VS Code 사용자 설정을 건드릴 필요가 없다. 원복 대상도 그 파일이 아니라
  `/tmp/mcplens-4th-udd/User/settings.json`이다 (`/tmp` 아래라 회차 후 자연 소멸한다).

---

## 7. 공유 DB 상태

- `PRAGMA quick_check` → **ok**
- `PRAGMA journal_mode` → `delete`, `PRAGMA user_version` → 0
- 파일: `~/.mcplens/lens.db` 8,167,424 바이트, mtime 02:23 (로컬)
- `lens.db-wal`, `lens.db-shm` **둘 다 없음** (잔존 없음)
- 활성 `~/.mcplens/db-writer.lock` **없음**
- 만료 lease 디렉터리 `db-writer.lock.reaping-*` **4개** (7월 22일 1개, 8월 3일 3개)
- inbox: **pending 3건**, processed 3209건
- 기존 백업 `lens.db.bak-20260720-182555`(1.6MB)는 7월 20일 시점이라 이번 회차 롤백에는 쓸 수 없다

### 격리되지 않은 VS Code 프로세스

**없다.** 실행 중인 VS Code는 1개이며 다음과 같이 완전히 격리돼 있다.

- `--user-data-dir=/tmp/mcplens-4th-udd` (전용 프로필)
- `--disable-extensions` (다른 확장 비활성)
- `--extensionDevelopmentPath=<이 worktree>/packages/extension`
- 열린 폴더도 이 worktree

`ps`에 잡히는 다른 Electron 프로세스는 Claude 데스크톱 앱의 크래시 핸들러와
macOS `CursorUIViewService`(텍스트 입력 프레임워크, Cursor 편집기와 무관)이며 둘 다 무관하다.

### 행 수 기준선

| 테이블 | 행 수 |
|---|---|
| sessions | 732 |
| tool_calls | 1135 |
| tool_loads | 497 |
| **tool_definitions** | **95** |
| **tool_definition_bodies** | **0** (테이블은 존재) |
| client_servers | 10 |
| ingest_observations | 3900 |
| session_aliases | 343 |
| token_usage | 52533 |
| file_cursors | 755 |
| server_identities | 0 |
| dependency_analyses | 0 |
| tool_dependency_results | 0 |
| tool_explanations | 0 |
| global_actions | 0 |
| regret_signals | 0 |
| collector_receipts | 0 |
| inference_consents | 0 |

`tool_definitions` 서버별 집계: `vercel` 30, `notion` 20, `lenstest` 12,
`lenstest-codex` 12, `lenstest2` 12, `deepwiki` 3, `node_repl` 3, `tiny` 3.

`tool_definition_bodies`는 전체 0행이라 서버별 집계가 없다. 즉 모든 툴이
`missing-definition-body`로 액션이 막힌 상태이며, 스캔이 이것을 채우는 첫 실환경 적재가 된다.

`~/.mcplens/disabled-servers.json`은 `{}`이고, `~/.claude/settings.json`의
`permissions.deny`는 **0건**이다. 즉 이전 회차 잔여물 없이 깨끗한 출발선이다.

---

## 8. 후보 툴 선정

### 필터 조건 (코드 근거)

`packages/core/src/engine/engine.ts:152-155`는 지배 모드가 `UPFRONT`가 아니면
`callCount > 0 || loadedSessionCount > 0`인 행만 남긴다. 이 필터는 `matrixTree.ts:142`에서
확장 트리를 만들 때 적용되고, 전역 액션은 트리 노드에서만 호출된다
(`extension.ts:453`의 `actionClient(node)`). **즉 트리에 안 보이면 액션을 걸 수 없다.**

후보는 추측 없이 dist 엔진으로 실제 트리를 재구성해 뽑았다
(`allDefinitions` + 30일 창의 `callsSince`/`loadsSince`/`sessionsSince` + `lastCallByTool`
+ `serversByClient` → `splitByClient` → `buildMatrix` → `visibleMatrixRows`).

### Claude Code 후보 (mode `DEFERRED_MEASURABLE`, rows 109 / visible 61)

visible 61행 중 `callCount = 0`인 행에서 골랐다.

| 서버/툴 | 정의 토큰 | callCount | loadedSessionCount | 권고 | 확신 |
|---|---|---|---|---|---|
| **lenstest/summarize_url** | 80 | 0 | 1 | `remove` | **high** |
| **lenstest/get_air_quality** | 82 | 0 | 1 | `remove` | **high** |
| lenstest2/summarize_url | 80 | 0 | 1 | `remove` | high |
| lenstest2/stock_quote | 82 | 0 | 1 | `remove` | high |
| lenstest2/search_restaurants | 79 | 0 | 1 | `remove` | high |
| lenstest2/book_reservation | 79 | 0 | 1 | `remove` | high |
| lenstest2/create_calendar_event | 77 | 0 | 1 | `remove` | high |
| lenstest2/track_flight | 76 | 0 | 1 | `remove` | high |
| lenstest2/send_notification | 76 | 0 | 1 | `remove` | high |
| lenstest2/get_weather | 74 | 0 | 1 | `remove` | medium (창 밖 호출 이력으로 강등) |
| notion/* 10개 | 186~3374 | 0 | 1 | `filter-server` | high |

- **1순위: `lenstest/summarize_url`.** 정의 80토큰, `loadPattern = search-pollution`,
  권고 `remove`, 확신 `high`, `lastCalledAt = null`.
- **2순위: `lenstest/get_air_quality`.** 정의 82토큰, 나머지 지표 동일.
- **관측 근거(직접 재조회).** `tool_loads`를 `sessions`에 조인한 결과
  `claude-code | lenstest | summarize_url | 1 세션 / 1행`,
  `claude-code | lenstest | get_air_quality | 1 세션 / 1행`.
  두 툴 모두 `tool_calls`에 행이 **0건**이다. 즉 **관측이 존재하며(가시성 확보)
  호출은 0(액션 자격)**이라는 두 조건을 동시에 만족한다.
- `lenstest`를 고른 이유: 전용 테스트 서버라 실제 작업에 쓰이지 않고, 저비용(80토큰)이며
  독립적인 목 툴이다. `notion`은 권고가 `filter-server`라 액션 성격이 다르고 실사용 서버다.
- **미확인 항목:** `Independent` 판정. `dependency_analyses`와 `tool_dependency_results`가
  0행이라 read-only로는 독립성을 확정할 수 없다. mutation 단계에서 의존성 분석을 돌린 뒤
  확인해야 한다.

### Codex 후보: **없음. 그리고 이번 계획으로도 만들 수 없다.**

이것이 이번 preflight의 가장 중요한 발견이다.

**현재 상태.** codex 트리는 rows 9 / visible 7이고, visible 7행이 **전부 `callCount > 0`**이다.

| 서버/툴 | callCount | loadedSessionCount |
|---|---|---|
| node_repl/js | 136 | 0 |
| lenstest2/get_weather | 5 | 0 |
| lenstest/lens_get_weather | 3 | 0 |
| lenstest2/convert_currency | 1 | 0 |
| codex/list_mcp_resources | 1 | 0 |
| codex/list_mcp_resource_templates | 1 | 0 |
| codex_apps/codex_document_control__list_document_sessions | 1 | 0 |

**구조적 원인.** codex의 `tool_loads`는 56행 / 28세션 있지만, `server_name`이 전부 비어 있고
`tool_name`이 전부 `(code-mode-search)`라는 단일 의사 툴이다. 즉 **codex는 개별 툴에
귀속되는 로드 관측을 원리적으로 만들지 않는다.** 따라서 codex 트리의 모든 행은
`loadedSessionCount = 0`이고, 가시성은 오로지 `callCount > 0`에만 달려 있다.

> 결론: codex에서 "`callCount = 0`이면서 트리에 보이는 툴"은 **존재할 수 없다.**
> 호출하면 `callCount > 0`이 되어 `called`로 액션이 막히고, 호출하지 않으면 트리에서 사라진다.

**사용자 계획을 read-only로 시뮬레이션했다.** DB 사본에서 `serversByClient`에
`codex → lenstest2`를 추가하고(설정 등록 후 스캔한 상태와 동치) 트리를 재구성한 결과다.

| lenstest2 툴 | calls | loadSess | 권고/확신 | 트리 가시 |
|---|---|---|---|---|
| get_weather | 5 | 0 | keep/high | **true** |
| convert_currency | 1 | 0 | keep/high | **true** |
| summarize_url | 0 | 0 | filter-server/high | **false** |
| stock_quote | 0 | 0 | filter-server/high | **false** |
| search_restaurants | 0 | 0 | filter-server/high | **false** |
| book_reservation | 0 | 0 | filter-server/high | **false** |
| create_calendar_event | 0 | 0 | filter-server/high | **false** |
| track_flight | 0 | 0 | filter-server/high | **false** |
| send_notification | 0 | 0 | filter-server/high | **false** |
| translate_text | 0 | 0 | filter-server/high | **false** |
| get_air_quality | 0 | 0 | filter-server/medium | false |
| get_forecast | 0 | 0 | filter-server/medium | false |

codex visible은 7 → 9로만 늘고, **zero-call 후보는 하나도 트리에 나타나지 않는다.**
등록·호출로는 이 벽을 넘을 수 없다.

**남은 이론적 경로 하나.** `visibleMatrixRows`는 지배 모드가 `UPFRONT`면 필터를 건너뛴다.
`packages/core/src/adapters/codex/adapter.ts:126-127`에 따르면 codex 세션은 code-mode search를
보지 못하고 tool call만 있으면 `UPFRONT`가 된다. 그러나 현재 창 안 codex 세션은
`DEFERRED_MEASURABLE` 28개 / `UPFRONT` 0개이므로, 다수결을 뒤집으려면 code-mode를 쓰지 않는
codex 세션을 29개 이상 만들어야 한다. 실행 가능한 준비 작업이 아니다.

---

## 9. 이번 회차 계획과 preflight 결과의 상충점

사용자 결정 사항은 "`~/.codex/config.toml`에 `lenstest2`를 임시 등록하고 TUI 명시 승인으로
훅 붙은 MCP 호출을 만들어 건강도를 회복시키고 zero-call 후보를 만든다"였다. 이를 두 개로
나눠 판정한다.

| 계획의 목표 | 판정 | 근거 |
|---|---|---|
| 훅 붙은 codex 호출로 **건강도 degraded 회복** | **달성 가능하고, 할 가치가 있다** | 세션 `019fc8a0`이 hook을 정상 전달했다. `MATCHES_TO_RECOVER = 2`이고 4차 보정으로 `tool-before`가 커버리지로 인정되므로 훅 붙은 호출 2회로 회복된다. 이것이 4차 보정의 실환경 검증 그 자체다 |
| 같은 조치로 **zero-call 후보 생성** | **달성 불가능** | 8절. codex는 툴별 로드 관측을 만들지 않으므로 `callCount = 0`인 행은 항상 트리에서 숨겨진다 |

**권고: 계획을 쪼개서 진행한다.** 건강도 회복은 예정대로 하고, "Codex 전역 액션을
zero-call 후보에 건다"는 목표는 이번 회차에서 **명시적으로 범위 밖으로 뺀다.**
대신 회복 이후 codex에서 확인할 것은 다음 둘로 한정한다.

1. `collectionHealthByClient()`의 codex가 `degraded` → `healthy`로 바뀐다.
2. 이제 `collection-health-unsafe`가 사라졌으므로, codex의 **called 툴**
   (예: `lenstest2/get_weather`)에 대해 `currentActionEligibility`가 남기는 사유가
   `called` 하나로 좁혀진다. 즉 건강도 게이트가 실제로 풀렸음이 사유 목록으로 증명된다.

이 두 가지는 Codex 액션 경로의 게이트가 의도대로 동작함을 실환경에서 보여주며,
후보 부재라는 환경 제약과 무관하게 검증 가치가 있다.

**별도 이슈로 남길 것.** "지연 로딩 클라이언트에서 툴별 로드 관측이 없으면 미사용 툴이
영원히 트리에 안 보여 액션 대상이 될 수 없다"는 점은 Codex에 한정된 제품 결함 후보다.
Claude Code는 툴별 로드 관측을 남기므로 같은 문제가 없다. 이 회차의 산출물로 기록해 둘 값어치가 있다.

---

## 10. 메인 오케스트레이터가 수행할 mutation 순서

1. **백업 확보.** 11절 목록을 회차 전 상태로 별도 보관한다. 특히 `lens.db`는 되돌릴 수
   없는 변경이 들어가므로 사본이 필수다. 액션 코드가 만드는 `.mcplens.bak-<ts>`는
   설정 파일에만 적용되고 DB에는 해당하지 않는다.
2. **rollout 확인만 한다.** 이미 격리 프로필에 `codex-beta`가 들어 있다(6절).
   일반 VS Code 사용자 설정은 **건드리지 않는다.**
3. **스캔을 돌린다.** `tool_definition_bodies`(현재 0행)와 `server_identities`(현재 0행)를
   처음 적재해야 `missing-definition-body`와 `identity-not-clear`가 풀린다.
   스캔 직후 `tool_definitions` 95행을 7절 기준선과 대조하고, bodies가 서버별로 채워지는지
   확인한다.
4. **의존성 분석을 돌린다.** `lenstest` 정의 집합에 대해 실행하고
   `lenstest/summarize_url`의 status가 `Independent`인지 확인한다.
   아니면 2순위 `lenstest/get_air_quality`, 그것도 아니면 `lenstest2`의 high 확신 툴로 대체한다.
   대체 시 `lenstest2/get_weather`는 확신 medium이므로 **고르면 안 된다.**
5. **Claude 전역 액션(비활성화)을 실행한다.** 대상 `lenstest/summarize_url`.
   `~/.claude/settings.json`의 `permissions.deny`(현재 0건)에 소유 규칙이 들어가고
   `global_actions`(현재 0행)에 active 행이 생기는지 확인한다.
6. **화면 확인.** 확장 트리와 리포트에서 액션 표시와 잠금 문구를 스크린샷으로 남긴다.
   프로젝트 규칙상 화면 검증은 눈으로 본 스크린샷 경로가 있어야 완료다.
7. **복원(restore)을 실행한다.** conflict 없이 `restored`로 끝나는지,
   `settings.json`의 `permissions.deny`가 다시 0건으로 돌아오는지 확인한다.
8. **2단계(정의 본문 비우기) 재현.** 3번에서 적재된 bodies 행 수를 기준선으로 삼아
   비운 뒤 `missing-definition-body`로 액션이 잠기는지, 재스캔으로 회복되는지 확인한다.
9. **Codex 경로 (9절의 축소된 범위로).**
   1. `~/.codex/config.toml`에 `lenstest2`를 임시 등록한다.
   2. **codex TUI를 띄워** 명시 승인으로 MCP 호출을 **2회 연속** 성사시킨다.
      호출 직후 `ingest_observations`에 해당 세션의 codex `hook` 행
      (`session-start` 또는 `tool-before`)이 실제로 들어왔는지 **먼저 확인한다.**
      훅이 안 붙었으면 즉시 중단한다. 계속하면 miss가 41에서 더 늘어난다.
   3. `collectionHealthByClient()`의 codex가 `healthy`가 되는지 확인한다.
      이것이 4차 보정의 실환경 회복 검증이다.
   4. `lenstest2/get_weather`(called 툴)에 대해 `currentActionEligibility`를 호출해
      사유 목록에서 `collection-health-unsafe`가 사라지고 `called`만 남는지 확인한다.
   5. **zero-call 후보에 대한 codex 액션 실행은 시도하지 않는다.** 8절대로 대상이 없다.
10. **정리.** `~/.codex/config.toml`의 `lenstest2` 등록을 제거해 회차 전 상태로 되돌리고,
    `db-writer.lock*` 잔존과 `lens.db-wal`/`-shm` 잔존이 없는지 재확인한다.
    확장 개발 호스트를 닫아 writer lease를 놓게 한다.

---

## 11. 백업 대상 파일

| 파일 | 성격 | 비고 |
|---|---|---|
| `~/.mcplens/lens.db` | 스캔·분석·액션 원장이 처음 적재된다 | **되돌릴 수 없다. 회차 전 사본 필수.** 기존 `lens.db.bak-20260720-182555`는 7월 20일분이라 못 쓴다 |
| `~/.claude/settings.json` | Claude 전역 액션이 `permissions.deny`를 고친다 | 액션이 `.mcplens.bak-<ts>`를 자동 생성. 그래도 회차 전 원본을 따로 보관 |
| `~/.codex/config.toml` | `lenstest2` 임시 등록을 손으로 넣는다 | **손 수정분은 자동 백업 대상이 아니다** |
| `~/.mcplens/disabled-servers.json` | 서버 단위 비활성화 경로가 쓴다 | 현재 `{}`. 이미 `.mcplens.bak`이 하나 있다 |
| `/tmp/mcplens-4th-udd/User/settings.json` | rollout 값이 여기 있다 | `/tmp` 아래라 소멸 가능. 값(`codex-beta`)을 기록해 두면 재생성으로 충분 |

일반 VS Code 사용자 설정(`~/Library/Application Support/Code/User/settings.json`)은
이번 회차에서 **건드리지 않으므로 백업 대상이 아니다.**

---

## 12. 남은 위험

1. **Codex zero-call 후보 부재는 준비로 해소되지 않는 구조적 제약이다.** 8절.
   이 사실을 모르고 등록·호출을 반복하면 시간만 쓰고 후보는 안 생기며,
   호출한 툴이 `called`가 되어 오히려 후보 풀이 줄어든다.
2. **codex 건강도 회복은 훅 전달 방식에 달려 있다.** 훅이 붙지 않는 실행 경로로 호출하면
   miss가 41에서 더 늘어난다. 10-9-2단계의 "hook 행 선확인"을 반드시 지켜야 한다.
3. **건강도는 전 기간 누적이라 과거 miss가 영구히 남는다.** 회복 후에도 훅 없는 세션이
   3번 끼면 즉시 degraded로 되돌아간다. 회차 동안 codex 사용을 이 터미널로 한정해야 한다.
4. **공유 DB에 6개 테이블이 이번에 처음 채워진다.** 빈 DB에 clean 로드하는 유닛테스트는
   이 경로를 검증하지 못한다. 머지 게이트에서 마이그레이션 번호를 재확인해야 한다.
5. **`Independent` 판정을 read-only로 확정하지 못했다.** 분석 캐시가 0행이라 1순위 후보가
   `Independent`가 아닐 가능성이 남는다. 2순위와 3순위 대체 경로를 미리 정해 둔 이유다.
6. **inbox pending 3건이 남아 있다.** 다음 확장 기동 시 처리되면서 DB 행 수가 7절 기준선에서
   미세하게 움직일 수 있다. 스캔 전후 대조 시 이 오차를 감안한다.
7. **만료 lease 디렉터리 4개가 회수되지 않고 있다.** 지금 동작을 막지는 않지만 정리 로직이
   만료분을 못 걷고 있음을 시사한다. 회차 중 lease 경합이 생기면 이것부터 의심한다.
8. **확장 개발 호스트가 지금 실행 중이다.** 격리돼 있으므로 문제는 없지만, 두 번째
   인스턴스를 띄우면 writer lease 경합이 생긴다. 회차 동안 개발 호스트는 하나만 유지한다.
9. **`lenstest2/get_weather`는 Claude 쪽에서도 확신 medium이다.** 창(30일) 안 호출은 0이지만
   `lastCallByTool`에 최근 호출이 남아 강등됐다. 대체 후보로 고르면 `confidence-not-high`로
   막힌다.
