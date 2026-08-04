# Wave 3 / Task 14 3차 실환경 E2E — read-only preflight 보고서

- 작성 시각: 2026-08-03 21:30 (KST)
- 작업 경로: `/Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/worktrees/mcplens-task-14-e2e`
- HEAD: `3a9b21a` (docs: Task 14 3차 실환경 E2E 터미널 프롬프트를 기록한다)
- 수행 범위: 읽기 전용. 설정·DB·로그를 수정·이동·백업하지 않았다.
- **판정: READY_FOR_MUTATION**

이 보고서에는 설정 원문, 시크릿, 환경변수 값, prompt·tool input·output 원문을 기록하지 않는다.
아래 근거는 모두 구조(키 이름, 개수, 상태 플래그, 해시 일치 여부)만 옮긴 것이다.

---

## 1. 명령별 결과

| 순서 | 명령 | 결과 |
|---|---|---|
| 1 | 지정 9개 스펙 대상 `npm test -- --run ...` | **PASS** (9 files / 136 tests). 단, 첫 시도는 실패했다. 아래 주석 참고 |
| 2 | `npx tsc --noEmit -p packages/core/tsconfig.json` | **PASS** (exit 0, 출력 없음) |
| 3 | `npx tsc --noEmit -p packages/extension/tsconfig.json` | **PASS** (exit 0, 출력 없음) |
| 4 | `npm test` | **PASS** (92 files / 974 tests, 5.12s) |
| 5 | `npm run build` | **PASS** (core / dashboard / extension 전부 성공) |
| 6 | `git diff --check` | **PASS** (exit 0, 공백 오류 없음) |

### 1-1. 순서를 바꾼 이유 (기록 필요)

지시받은 순서대로 1번을 먼저 돌렸을 때 아래 2개 파일이 **수집 단계에서 실패**했다.

- `packages/extension/test/analysisCoordinator.test.ts`
- `packages/extension/test/globalActionCommand.test.ts`

원인은 코드 결함이 아니다. 이 worktree는 새로 만들어진 것이라 `packages/core/dist/`가 없었고,
`packages/core/package.json`의 `main`이 `dist/index.js`를 가리키므로 vite가
`@mcp-lens/core` 엔트리를 해석하지 못했다. 실패 메시지는
`Failed to resolve entry for package "@mcp-lens/core"`였다.

그래서 5번(`npm run build`)을 먼저 수행한 뒤 1번을 다시 돌렸고 전부 통과했다.
이후 2·3·4·6번도 모두 통과했다.

**후속 회차에 반영할 사항**: 새 worktree에서 검증을 시작할 때는 `npm run build`가
`npm test`보다 **먼저** 와야 한다. extension 테스트는 core의 빌드 산출물에 의존한다.
현재 터미널 프롬프트의 명령 순서(테스트 → 빌드)는 새 worktree에서 항상 거짓 적신호를 낸다.

### 1-2. git 작업트리 상태

`git status --porcelain` 기준 untracked 2개뿐이다 (`.claude/`, `docs/pitfalls/`).
빌드 산출물은 gitignore되어 있어 빌드 후에도 추적 파일 변경이 없다. 커밋·머지·푸시는 하지 않았다.

---

## 2. Claude Code plugin·hook 설치와 신뢰 상태 — 정상

| 항목 | 근거 | 판정 |
|---|---|---|
| 플러그인 활성화 | `~/.claude/settings.json`의 `enabledPlugins`에 `mcp-lens@mcplens` = `true` | OK |
| 마켓플레이스 등록 | `extraKnownMarketplaces`에 `mcplens` 존재, `source.source` = `directory`, 경로 실재 확인 | OK |
| 설치 목록 반영 | `~/.claude/plugins/installed_plugins.json`(version 2)의 `plugins` 배열에 `mcp-lens@mcplens` 포함 | OK |
| 마켓플레이스 캐시 | `~/.claude/plugins/known_marketplaces.json`에 `mcplens` 항목 존재 (`installLocation`, `lastUpdated`, `source`) | OK |
| 차단 여부 | `~/.claude/plugins/blocklist.json`의 차단 목록은 `code-review@claude-plugins-official`, `fizz@testmkt-marketplace` 2건뿐. **mcp-lens는 차단되지 않았다** | OK |
| 훅 정의 | 플러그인의 `hooks/hooks.json`에 `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd` 5개 이벤트. MCP 대상 3개는 matcher가 `^mcp__.*` | OK |
| 실제 로드 | 이 preflight 세션 자체의 스킬 목록에 `mcp-lens:lens-audit`가 떠 있고, 실행 중인 Claude Code 프로세스 인자에 `--plugin-dir .../cache/mcplens/mcp-lens/0.1.0`가 들어가 있다. 선언만 된 게 아니라 **실제로 로드된다** | OK |

`~/.claude/settings.json`의 사용자 레벨 훅(SessionStart 2, PreToolUse 4, PostToolUse 3)은
MCP Lens 것이 아니다. MCP Lens 훅은 전부 플러그인 경유로 주입된다. 이는 설계대로다.

## 3. Codex hook 설치와 신뢰 상태 — 정상

| 항목 | 근거 | 판정 |
|---|---|---|
| 플러그인 활성화 | `~/.codex/config.toml`의 `plugins`에 `mcp-lens@mcplens` = `enabled: true` | OK |
| 마켓플레이스 등록 | `marketplaces`에 `mcplens` 항목 존재 (`source_type`, `source`, `last_updated`) | OK |
| 훅 기능 플래그 | `features.plugin_hooks` = `true`. 이게 꺼져 있으면 Codex 훅이 아예 안 뜬다 | OK |
| 훅 신뢰 | `hooks.state`에 `mcp-lens@mcplens:hooks/hooks.json:...` 접두사를 가진 항목 **4개**가 각각 `trusted_hash`를 갖고 있다 | OK |
| 훅 정의 | 설치본 `hooks/hooks.json`에 `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` 4개 이벤트, 각 1 entry. 신뢰 항목 4개와 개수가 일치한다 | OK |
| 플러그인 버전 | `.codex-plugin/plugin.json` = `mcp-lens` 0.1.0. Claude 쪽 `.claude-plugin/plugin.json`과 동일 | OK |

**주의 항목**: `hooks.state`에는 구 식별자 `mcp-lens@mcplens-local:` 접두사 항목이 **4개 더**
남아 있다. `marketplaces`에는 `mcplens-local`이 없으므로 죽은 항목이다. 동작에는 영향이 없으나
(활성 식별자는 `mcp-lens@mcplens`) 나중에 훅 출처를 세는 로직이 생기면 이중 계상 위험이 있다.

## 4. 런타임 스탬프 일치 — 드리프트 없음

설치된 훅 런타임이 이 worktree HEAD의 빌드와 같은 것인지 확인했다. 스탬프 값은 6개 위치에서 전부 동일했다.

- `~/.mcplens/installed-runtime.json` (gemini-cli / claude-code / codex 3개 항목 전부)
- `~/.mcplens/claude-marketplace/mcp-lens/runtime/runtime-stamp.json`
- `~/.mcplens/codex-marketplace/plugins/mcp-lens/runtime/runtime-stamp.json`
- `~/.claude/plugins/cache/mcplens/mcp-lens/0.1.0/runtime/runtime-stamp.json`
- 이 worktree의 신규 빌드 산출물 `packages/extension/dist/gemini-extension/runtime/runtime-stamp.json`

즉 **설치본을 다시 밀어넣지 않아도 현재 코드와 같은 런타임이 돌고 있다.**
이번 회차에서 런타임 재설치는 필요 없다. (원문 해시값은 이 보고서에 남기지 않는다.)

## 5. 두 클라이언트의 수집 건강도 — 양호

`~/.mcplens/lens.db`를 `file:...?mode=ro` URI로 열어 읽기만 했다.

`ingest_observations` 기준:

| client | 관측 수 | 최근 관측 |
|---|---|---|
| claude-code | 3194 | 2026-08-03T12:28:17Z |
| codex | 657 | 2026-08-03T11:49:46Z |
| gemini-cli | 14 | 2026-07-23T05:43:15Z |

`sessions` 기준: claude-code 412, codex 300, gemini-cli 8.
`tool_calls` 기준: claude-code 983, codex 146, gemini-cli 4.

**판정**: 이번 회차 대상인 claude-code와 codex 모두 **오늘 날짜 관측이 있다.**
수집 경로가 살아 있다는 뜻이다. gemini-cli는 7월 23일이 마지막이나 이번 회차 대상이 아니다.

inbox 상태: `pending/`이 **비어 있다**(0건). 미처리 백로그가 없다.
다만 `.locks/`에 12,765건, `processed/`에 3,183건이 누적되어 있다. 동작에는 지장이 없지만
증가만 하는 구조라 장기적으로는 정리 정책이 필요하다 (아래 위험 항목).

`collector_receipts` 테이블은 **비어 있다**(0행). 스키마는 존재한다. 이 회차의 건강도 판정은
`ingest_observations`의 클라이언트별 최근 관측 시각으로 대체했다. receipts가 이번 회차에서
채워져야 하는 계약이라면 mutation 후 검증 항목에 넣어야 한다 (아래 위험 항목).

## 6. config-derived identity 충돌 — 충돌 0건

빌드된 core의 `collectAllSpecs()`를 읽기 전용으로 호출해 실측했다.

- 읽은 설정 소스: 55개
- 수집된 서버: `deepwiki`, `figma`, `github`, `lenstest`, `lenstest2`, `node_repl`, `notion`, `tiny`, `vercel`
- 건너뛴 서버: `computer-use` (Codex에서 `enabled=false`)
- **`conflictState !== 'clear'`인 identity: 0건**

주요 identity 상태:

| client | server | source | transport | conflict |
|---|---|---|---|---|
| claude-code | lenstest | claude-user | stdio | clear |
| claude-code | lenstest2 | claude-user | stdio | clear |
| claude-code | vercel | claude-user | http | clear |
| claude-code | vercel | claude-project | http | clear |
| codex | node_repl | codex | stdio | clear |
| gemini-cli | notion / tiny | gemini | http / stdio | clear |

### 6-1. lenstest ↔ lenstest2 동일 엔드포인트 (충돌 아님, 그러나 알고 있어야 함)

`~/.claude.json`의 `lenstest`와 `lenstest2`는 **transport·command·args가 완전히 동일**하다
(같은 데모 서버 스크립트를 가리킨다). 따라서 두 서버의 툴 목록도 동일하다.

이것이 identity 충돌로 잡히지 않는 이유는 `markEndpointConflicts()`가
**"같은 serverName인데 endpointHash가 다른 경우"**만 conflict로 표시하기 때문이다
(`packages/core/src/scanner/sources.ts:187-205`). 지금은 **이름이 다르고 엔드포인트가 같은**
반대 방향이므로 설계상 `clear`가 맞다.

다만 E2E 귀속(attribution) 관점에서는 실질적 위험이다. 두 서버의 툴 이름이 겹치므로
`tool_name`만으로는 어느 서버 호출인지 구분할 수 없고 `server_name`을 반드시 함께 봐야 한다.
후보 선택에서 이 점을 회피했다 (아래 7절).

## 7. 공유 DB · writer lease · WAL/SHM — 정상

| 항목 | 결과 |
|---|---|
| `PRAGMA quick_check` | **ok** |
| `PRAGMA journal_mode` | `delete` |
| `lens.db` 크기 / 갱신 | 8,044,544 바이트 / 2026-08-03 21:28 |
| `lens.db-wal` / `lens.db-shm` | **둘 다 없음** |
| 활성 lease 디렉터리 `~/.mcplens/db-writer.lock` | **없음** (락 미보유) |
| `lsof ~/.mcplens/lens.db` | 결과 없음 (현재 DB 파일을 잡고 있는 프로세스 없음) |
| `PRAGMA user_version` | 0 (코드에도 `user_version` 사용처가 없다. 이 프로젝트는 user_version으로 마이그레이션을 추적하지 않는다) |

**WAL/SHM 부재 해석 주의**: journal_mode가 `delete`이므로 `-wal`/`-shm` 파일은 애초에 생기지
않는다. 즉 이 부재는 "깨끗하게 종료됐다"의 증거가 아니라 "이 모드에서는 원래 없다"이다.
깨끗함의 실제 근거는 `quick_check = ok`와 활성 lease 부재다.

### 7-1. 잔존 writer lease (정리 필요, 차단은 아님)

`~/.mcplens/` 아래에 `db-writer.lock.reaping-<hash>` 디렉터리가 **4개** 남아 있다.
각각 `owner.json`, `expiry.json`을 갖고 있다. 만료 시각을 현재 시각과 대조한 결과
**4개 전부 이미 만료**되었다.

| 디렉터리(축약) | 만료 상태 |
|---|---|
| `07829c26eeea…` | 만료 (약 12일 경과) |
| `5a3036e9f649…` | 만료 (약 4.8시간 경과) |
| `c6147300849b…` | 만료 (약 4.7시간 경과) |
| `db27c74d23de…` | 만료 (약 4.7시간 경과) |

활성 lease 디렉터리가 없고 전부 만료 상태이므로 **writer 경로는 비어 있다.**
이 4개는 reaping(회수) 도중 이름만 바뀐 채 삭제되지 않은 잔여물이다.
읽기 전용 preflight이므로 지우지 않았다. 3개가 같은 시간대(오늘 16:45~16:50)에 몰려 있는 점은
2차 회차 종료 시점에 회수 로직이 마지막 unlink를 못 끝냈을 가능성을 시사한다.

## 8. 격리되지 않은 VS Code 프로세스 — **발견됨 (mutation 전 조치 필요)**

- `/Applications/Visual Studio Code.app` 본체 PID 57825가 **약 1시간 30분째 실행 중**이며,
  자식 Code Helper 프로세스 6개가 함께 떠 있다 (총 7개).
- 그리고 `~/.vscode/extensions`에 **`seodduu.mcp-context-lens-0.1.1`**이 설치되어 있다.
  즉 이 VS Code는 MCP Lens 확장을 가진 채 떠 있다.
- 현재 시점 `lsof` 상 `lens.db`를 잡고 있지는 않다. 하지만 확장이 스캔·집계를 트리거하면
  공유 DB에 쓰기가 발생할 수 있다.

**이것이 mutation 전 유일한 실질 조치 항목이다.** mutation 창(window) 동안 확장이 스캔을 돌리면
writer lease 경합이 생기거나 이번 회차 관측에 섞인 데이터가 들어가 결과 판정이 오염된다.

추가로 확인된 동시 실행 요소:

- `lenstest-server.mjs` node 프로세스가 **4개** 떠 있다 (PID 56574·56575 = 약 1시간 32분,
  PID 73251·73252 = 약 42분). 즉 lenstest/lenstest2를 물고 있는 **Claude Code 세션이 최소 2개**
  동시에 살아 있다.
- 그중 하나는 이 preflight를 수행 중인 세션 자신이다.

mutation 시점에 다른 Claude Code 세션이 살아 있으면 그 세션의 MCP 호출도 훅에 잡혀
이번 회차 관측에 섞인다.

---

## 9. 이번 회차 MCP test tool 후보

### 9-1. 후보 선정에 쓴 실측 데이터

`tool_definitions`와 `tool_calls`·`ingest_observations`를 조인해 lenstest/lenstest2의
24개 툴 전부에 대해 기존 호출·관측 건수를 셌다. 완전 미사용(calls 0 **그리고** obs 0)인 것은 아래뿐이다.

- `lenstest`: `book_reservation`, `create_calendar_event`, `get_forecast`,
  `search_restaurants`, `send_notification`, `summarize_url`, `track_flight`, `translate_text`
- `lenstest2`: `translate_text`

`translate_text`는 **두 서버 모두에서 calls 0 / obs 0**인 유일한 툴이다.

### 9-2. Claude 후보

**1순위: `mcp__lenstest__translate_text`** (정의 토큰 74)

| 요구 조건 | 충족 근거 |
|---|---|
| 미사용 | `lenstest.translate_text`: tool_calls 0건, ingest_observations 0건. 짝인 `lenstest2.translate_text`도 0/0이라 **툴 이름만으로도 이번 회차 신규 관측을 식별할 수 있다.** 6-1의 동일 엔드포인트 문제를 정면으로 회피한다 |
| 독립 | 입력이 텍스트와 목표 언어뿐이다. 다른 툴 출력이나 선행 상태에 의존하지 않는다. 데모 서버라 외부 네트워크 부작용도 없다 |
| 고신뢰 | 같은 서버의 다른 툴(`get_weather` 등)이 `correlation_confidence = high`로 기록된 이력이 있다. Claude 훅은 native call_id를 넘기므로 `makeCorrelationKey()`가 `native:` 접두사 경로를 탄다 |
| 실제 트리에 뜸 | 이 세션의 사용 가능 툴 목록에 `mcp__lenstest__translate_text`가 실제로 올라와 있다. 설정에만 있고 안 뜨는 상태가 아니다 |
| 저비용 | 정의 74토큰. lenstest 툴 중 최저 티어 |

**2순위(백업): `mcp__lenstest__track_flight`** (정의 토큰 76).
`lenstest` 쪽은 0/0이나 `lenstest2.track_flight`에 과거 관측 1건이 있어 `server_name`을 반드시
함께 봐야 한다. 그래서 2순위다.

### 9-3. Codex 후보

**`mcp__lenstest2__track_flight`**

| 요구 조건 | 충족 근거 |
|---|---|
| 코드모드 exact lookup 가능 | `packages/core/src/adapters/codex/adapter.ts:289`의 `extractExactCanonicalSearch()`는 `ALL_TOOLS.filter(t => t.name === "<이름>")` 형태에서만 정확 이름을 뽑는다. 그리고 `isCanonicalMcpToolName()`(`:243`)이 `^mcp__[A-Za-z0-9][A-Za-z0-9_-]*__[A-Za-z0-9][A-Za-z0-9_-]*$`를 요구한다. `mcp__lenstest2__track_flight`는 이 정규식을 만족한다 (`lenstest2`의 숫자도 허용 문자다) |
| Codex 측 미사용 | Codex 클라이언트의 lenstest2 관측은 `get_weather`(3), `convert_currency`(1)뿐이다. `track_flight`는 Codex에서 **0건** |
| 이름 충돌 없음 | 현재 Codex가 보는 툴은 `node_repl.js`, `codex.list_mcp_resource*`, `codex_apps.*`뿐이다. `track_flight`와 겹치는 이름이 없어 검색 결과가 1건으로 확정된다 (`matches.length !== 1`이면 null 반환이므로 이 조건이 중요하다) |
| Claude 후보와 분리 | Claude는 `translate_text`, Codex는 `track_flight`를 쓴다. 툴 이름만으로 두 클라이언트의 신규 관측을 분리 검증할 수 있다 |

**전제 조건 (mutation 필요)**: 현재 `~/.codex/config.toml`의 `mcp_servers`에는
`computer-use`(비활성), `node_repl`, `openaiDeveloperDocs`만 있고 **lenstest2가 없다.**
과거 Codex 관측에 lenstest2가 남아 있는 것으로 보아 이전 회차에서 등록했다가 정리한 상태다.
따라서 이번 회차에는 **lenstest2를 Codex 설정에 다시 등록하는 mutation이 선행되어야 한다.**

**Codex에는 lenstest2 하나만 등록할 것.** lenstest와 lenstest2를 둘 다 등록하면 툴 이름이
동일하므로 `ALL_TOOLS.filter(...)` 결과가 2건이 되어 exact lookup이 깨진다.

---

## 10. 메인 오케스트레이터가 수행할 mutation 순서

아래 순서를 지켜야 한다. 특히 1~3번을 건너뛰면 관측이 오염되어 판정 자체가 무의미해진다.

1. **VS Code 종료.** PID 57825와 자식 Code Helper 전부. `seodduu.mcp-context-lens-0.1.1`이
   설치되어 있어 실행 중이면 공유 DB에 쓰기가 발생할 수 있다. 종료 후 `lsof ~/.mcplens/lens.db`가
   비어 있는지 재확인한다.
2. **이 preflight 세션 외 다른 Claude Code 세션 종료.** `lenstest-server.mjs` 프로세스가
   4개 떠 있다(세션 2개). mutation 창 동안 살아 있으면 그 세션의 MCP 호출이 섞인다.
3. **백업 수행** (11절 목록). 원본은 읽기 전용 원칙이므로 반드시 복사본을 만든다.
4. **기준선(baseline) 스냅샷 기록.** 아래 값을 mutation 직전에 남긴다.
   - `SELECT COUNT(*) FROM ingest_observations WHERE tool_name IN ('translate_text','track_flight');`
   - `SELECT COUNT(*) FROM ingest_observations WHERE client='claude-code';` 및 `client='codex'`
   - `SELECT MAX(observed_at) FROM ingest_observations;`
   - `PRAGMA quick_check;` (ok 확인)
5. **잔존 lease 정리.** `~/.mcplens/db-writer.lock.reaping-*` 4개는 전부 만료 상태다.
   삭제하거나, 남겨둘 경우 회차 종료 후 개수가 늘지 않았는지 확인한다.
6. **Codex 설정 mutation.** `~/.codex/config.toml`의 `mcp_servers`에 `lenstest2`만 추가한다
   (stdio, 데모 서버 스크립트 경로). `lenstest`는 추가하지 않는다 (9-3의 이름 충돌 회피).
   `features.plugin_hooks = true`와 `plugins`의 `mcp-lens@mcplens` 활성 상태는 이미 맞으므로 건드리지 않는다.
7. **Claude 측 mutation 불필요.** `lenstest`가 이미 `~/.claude.json`에 등록되어 있고
   `mcp__lenstest__translate_text`가 실제 트리에 뜬다. 런타임 스탬프도 현재 빌드와 일치하므로
   플러그인 재설치도 필요 없다.
8. **Claude 실행 회차.** 새 Claude Code 세션에서 `mcp__lenstest__translate_text`를 1회 호출한다.
   호출 횟수와 시각을 기록한다.
9. **Codex 실행 회차.** Codex 세션에서 코드모드 정확 검색
   `ALL_TOOLS.filter(t => t.name === "mcp__lenstest2__track_flight")` 형태로 조회한 뒤
   해당 툴을 1회 호출한다. `filter`/`find` 이외 형태나 검색식이 2개 이상이면 exact lookup이 깨진다.
10. **검증.** 4번 기준선과 대조한다.
    - `translate_text` 신규 관측이 `client='claude-code'`, `server_name='lenstest'`,
      `correlation_confidence='high'`로 들어왔는가
    - `track_flight` 신규 관측이 `client='codex'`, `server_name='lenstest2'`로 들어왔는가
    - 코드모드 경로면 `tool_loads`에서 `(code-mode-search)` 대신 정확 이름
      `mcp__lenstest2__track_flight`로 승격되었는가 (`adapter.ts:97-98` 경로)
    - `PRAGMA quick_check`가 여전히 `ok`인가
    - `inbox/pending`이 다시 비었는가
    - `~/.mcplens/db-writer.lock`이 남아 있지 않은가
11. **원복.** 6번에서 추가한 Codex `lenstest2` 항목을 제거해 원래 상태로 되돌린다.

## 11. 백업 대상 파일 목록

mutation 전에 복사본을 만들어야 하는 파일이다. 원본 수정 전 백업이 원칙이다.

| 경로 | 이번 회차 변경 여부 | 비고 |
|---|---|---|
| `~/.codex/config.toml` | **변경 예정** (lenstest2 추가 후 원복) | 최우선 백업 대상 |
| `~/.mcplens/lens.db` | 변경됨 (관측 추가) | 8MB. 실패 시 되돌릴 유일한 수단 |
| `~/.claude.json` | 변경 없음 예정 | 세션 종료 시 Claude가 스스로 갱신하므로 방어적으로 백업 |
| `~/.claude/settings.json` | 변경 없음 예정 | 방어적 백업 |
| `~/.mcplens/installed-runtime.json` | 변경 없음 예정 | 재설치가 일어나면 갱신됨 |
| `~/.mcplens/disabled-servers.json` | 변경 없음 예정 | 이미 `.mcplens.bak` 사본이 옆에 있다. 과거 회차에서 건드린 이력이 있다는 뜻이므로 포함 |

백업 파일명에는 회차와 타임스탬프를 넣는다 (예: `<원본>.bak-3rd-<YYYYmmdd-HHMMSS>`).
`~/.mcplens/lens.db.bak-20260720-182555`가 이미 있으므로 덮어쓰지 않도록 주의한다.

## 12. 남은 위험

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| 1 | **VS Code(PID 57825)가 MCP Lens 확장과 함께 실행 중** | 확장 스캔이 공유 DB에 쓰면 이번 회차 관측이 오염되고 writer lease 경합이 난다 | mutation 전 반드시 종료 (10절 1번). 유일한 필수 선행 조치 |
| 2 | **동시 Claude Code 세션 최소 2개** (`lenstest-server.mjs` 4개) | 다른 세션의 MCP 호출이 훅에 잡혀 신규 관측에 섞인다 | 회차 전 정리, 또는 기준선 대조 시 세션 ID로 필터 |
| 3 | `db-writer.lock.reaping-*` 4개 잔존 (전부 만료) | 지금은 무해. 회수 로직이 마지막 unlink를 못 끝내는 버그가 있을 수 있다 | 3개가 오늘 16:45~16:50에 몰려 있다. 회차 종료 후 개수가 또 늘면 회수 로직 결함으로 확정 |
| 4 | `collector_receipts` 테이블이 완전히 비어 있음 (0행) | 수집 영수증이 설계상 채워져야 하는데 안 채워지는 것이면 미구현·미배선 결함이다 | 이번 회차 후 여전히 0행이면 별도 이슈로 분리. 건강도 판정은 `ingest_observations`로 대체했다 |
| 5 | Codex `openaiDeveloperDocs`가 스캐너 수집 결과에 없음 | `mcp_servers`에는 있으나 `collectAllSpecs()` 결과의 codex 서버는 `node_repl` 하나뿐. Codex의 url 전용 http 서버 transport 판별이 `unknown`으로 떨어지는 것으로 보인다 | 이번 회차 후보와 무관하므로 차단 요소는 아니다. Codex http 서버 수집 누락 가능성으로 별도 기록 |
| 6 | `~/.claude.json`에서 `MCPLens-V2` 프로젝트가 `hasTrustDialogAccepted = false`, worktree 경로는 아예 미등록 | 터미널에서 새 Claude Code 세션을 worktree에서 띄우면 신뢰 대화상자가 떠 훅 로딩 전에 막힐 수 있다 | 회차 시작 시 신뢰를 먼저 수락한다. 참고로 `MCPLens`(v1)는 `true`다 |
| 7 | Codex `hooks.state`에 죽은 `mcp-lens@mcplens-local:` 항목 4개 잔존 | 현재는 무해. 훅 출처를 세는 로직이 생기면 이중 계상 | 정리 권장, 이번 회차 차단 요소 아님 |
| 8 | `lenstest`와 `lenstest2`가 동일 엔드포인트·동일 툴셋 | `tool_name`만으로 서버를 구분할 수 없다. 검증 쿼리에서 `server_name`을 빠뜨리면 오판한다 | 두 서버 모두 0/0인 `translate_text`를 Claude 후보로 골라 회피했다. 검증 쿼리에 `server_name` 조건을 반드시 포함 |
| 9 | `inbox/.locks` 12,765건 / `processed` 3,183건 누적 | 파일 수가 단조 증가한다. 장기적으로 디렉터리 조회 성능 저하 | 이번 회차 차단 요소 아님. 정리 정책 필요 항목으로 기록 |
| 10 | 새 worktree에서 빌드 전 테스트가 실패한다 | 후속 회차마다 거짓 적신호로 시간을 쓴다 | 터미널 프롬프트의 명령 순서를 `npm run build` 선행으로 고칠 것 (1-1절) |

---

## 13. 최종 판정

**status: READY_FOR_MUTATION**

- 검증 명령 6개 전부 통과 (빌드 선행 조건 반영 후)
- Claude·Codex 양쪽 플러그인·훅 설치 및 신뢰 상태 정상, 런타임 스탬프가 현재 빌드와 일치
- 두 클라이언트 모두 당일 관측 존재, 수집 경로 살아 있음
- config-derived identity 충돌 0건 (실측)
- `PRAGMA quick_check` = ok, 활성 writer lease 없음, DB 점유 프로세스 없음
- Claude·Codex 후보 각 1개 확보, 선정 근거는 DB 실측과 어댑터 코드 경로로 뒷받침됨

단, **mutation 착수 전에 10절 1~3번(VS Code 종료 / 타 세션 정리 / 백업)을 반드시 먼저 수행해야 한다.**
