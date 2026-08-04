# MCP Lens v2 Wave 3 — Task 14 실제 regret·Codex load 귀속 보정 계획

## 목표

Task 14 새 실환경 E2E에서 확인한 두 현재 클라이언트 계약 차이를 보정한다.

1. Claude Code의 활성 deny 규칙 아래에서 `PreToolUse`가 오지 않아도, transcript의 구조화된 정확 MCP tool 결과로 실제 사용 시도를 direct regret로 기록한다.
2. Codex exact code-mode search가 성공해 정의를 로드한 경우 exposed tool name을 원문 없이 보존하고, store에서 현재 스캔 정의와 config-derived client/server attribution으로 유일하게 역매핑해 실제 `ToolLoadEvent` 행을 만든다.
3. no-match, user-cancelled, malformed, ambiguous search는 기존 generic code-mode load로 남겨 false-positive action eligibility를 만들지 않는다.

완료 기준은 fixture와 `:memory:` DB 회귀, core package 타입체크, 전체 `npm test`, 전체 build, `git diff --check`, 독립 spec/quality review 통과다. 통합 뒤 새 Task 14 worktree와 새 실행 직전 backup으로 Claude/Codex action→regret→restore를 다시 실행한다.

## 실환경 근거

- fresh E2E 보고서: `/tmp/mcplens-v2-e2e-report-fresh.md`.
- Claude: 활성 MCP Lens deny rule 아래 새 세션 transcript에는 정확한 MCP `tool_use`와 `is_error=true` 결과가 있었지만 hook `PreToolUse`는 없었다. action restore 뒤 같은 툴의 새 세션 호출은 성공했다.
- Codex: 비대화형 MCP 호출은 승인 UI 부재로 취소됐고, TUI 명시 승인 호출 2회는 성공해 hook/log 건강도를 정상으로 회복했다.
- Codex exact search 성공 세션은 generic `(code-mode-search)` load만 남겼다. `server_name=null`이라 지연 로딩 표시 필터가 callCount=0 정의를 숨겼고 action eligibility가 생성되지 않았다.
- 원문 prompt, tool input/output, 사용자 설정, 시크릿, endpoint/hash는 계획·테스트·report에 기록하지 않는다.

## 비범위

- `packages/core/src/types.ts`, `packages/core/src/store/schema.sql`, 루트 설정은 수정하지 않는다.
- regret 임계값, action mutation 형식, identity 충돌 판정, DB DDL은 변경하지 않는다.
- fuzzy server/tool 매칭, raw search output 저장, raw Claude error 저장은 추가하지 않는다.
- Task 14 worktree와 실제 사용자 설정·공유 DB를 구현·유닛 테스트에서 사용하거나 수정하지 않는다.
- 실제 클라이언트 검증은 제품 통합 뒤 새 직렬 E2E로 분리한다.

## Task 14-runtime-remediation — 구조화된 Claude attempt와 Codex exact load

**기준 commit:** `26267d212ab4d296a627b8d611aff64c71c402ea`

**Worktree:** `/Users/doo._.hyun/Study/Project/MCPLens-V2-worktrees/task-14-runtime-remediation`

**Branch:** `fix/v2-runtime-regret-load-remediation`

**역할:** `.codex/agents/mcplens-adapter-implementer.toml`, `gpt-5.6-terra / medium`

**Files:**

- Modify: `packages/core/src/adapters/codex/adapter.ts`
- Modify: `packages/core/src/regret/claudeAttempt.ts`
- Modify: `packages/core/src/store/store.ts`
- Modify: `packages/core/test/adapters/codex/adapter.test.ts`
- Modify: `packages/core/test/regret/claudeAttempt.test.ts`
- Modify: `packages/core/test/store/observations.test.ts`
- Modify: `packages/core/test/store/v2Contracts.test.ts`
- Create: `fixtures/codex/tool-search-success.jsonl`

### Claude direct regret 계약

1. direct attempt 증거는 다음 중 하나다.
   - 기존 hook `source=hook`, `phase=tool-before`.
   - transcript의 구조화된 MCP 결과 `source=log`, `phase=tool-failure` 또는 `phase=tool-after`.
2. 두 경로 모두 client가 `claude-code`, server/tool이 null이 아니고 활성 Claude action과 정확히 일치하며 observation 시각이 action 생성 시각 이상이어야 한다.
3. generic load인 `source=log`, `phase=tool-before`는 direct regret가 아니다.
4. 동일 action/kind/session은 기존 DB primary key로 멱등 처리한다. hook과 log가 함께 오더라도 signal은 1건이다.
5. `LensStore.ingest()`의 log observation 적재 경로도 `directClaudeRegretSignals()`를 호출한다. raw result와 input은 저장하지 않는다.

### Codex exact load 계약

1. adapter는 JS line/block comment를 문자열 밖에서 제거하고 실제 single/double string literal을 placeholder로 마스킹한 뒤, `ALL_TOOLS.filter/find(<id> => <same-id>.name ==/=== <canonical literal>)`에 결합된 정확한 단일 비교만 인식한다. 주석·문자열 안의 가짜 비교와 broad/substring 검색은 exact가 아니다.
2. 같은 call id의 output content block을 서로 이어 붙이지 않고 각각 구조적으로 분류한다. success와 no-match는 하나의 상호배타적 classifier 결과를 공유한다.
3. success는 지원하는 최상위 definition 배열 노드가 정확히 하나이고 그 배열의 유일한 원소 `name`이 exact tool name과 같은 경우뿐이다. 임의 wrapper나 nested metadata의 `name`은 정의 증거가 아니다.
4. no-match는 독립 JSON 빈 배열 또는 허용된 실행 metadata 뒤 standalone `TOOL_NOT_FOUND` line만 인정한다. malformed JSON, definition 배열, 중복/모호한 shape, 취소·오류 증거가 함께 있거나 sentinel이 prose substring으로만 나오면 no-match가 아니다.
5. success/no-match 이외 output은 기존 `(code-mode-search)` generic load를 유지한다. no-match일 때만 기존 `ToolSearchAttempt(noMatch=true)`를 만든다.
6. adapter는 raw output을 산출 type이나 DB에 추가하지 않고 기존 `loadedTokens` 계산만 유지한다.
7. 현재 Codex exposed MCP name은 `mcp__${serverName}__${toolName}`이다. `LensStore.ingest()`는 client가 Codex이고 `serverName=null`인 exact-name load만 현재 `tool_definitions`와 `client_servers`로 역매핑한다. canonical exposed name이 같은 후보 중 Codex에 실제 설정된 서버의 정의가 정확히 하나일 때만 server/tool을 귀속한다.
8. Codex indirect regret의 exact no-match도 같은 canonical exposed name만 활성 action과 일치시킨다. legacy underscore 연결, substring, fuzzy 이름은 신호가 아니다.
9. 0개 또는 2개 이상 후보, Codex 미설정 서버, generic load는 귀속하지 않는다. fuzzy/substring 매칭은 금지한다.
10. 귀속된 load는 기존 observation→session materialization을 거쳐 `tool_loads`에 한 번 저장되고 re-ingest에도 중복되지 않으며 `loadedTokens`를 보존한다.

### 회귀 테스트

- success fixture는 canonical exact search input과 실제 framing을 닮은 metadata content block + 별도 구조화 단일 matching definition content block만 포함한다. 실제 prompt·tool input/output·시크릿을 복사하지 않고 익명 서버/툴을 사용한다.
- adapter success: exact exposed name과 양수 `loadedTokens`, no regret attempt.
- adapter no-match/cancel/malformed/ambiguous: generic load 유지, no-match만 attempt 생성.
- 주석·문자열 안 exact 비교, nested metadata name, sentinel prose, sentinel+malformed, sentinel+multiple definitions은 generic/attempt 0.
- metadata block + 별도 JSON `[]` block은 no-match attempt 정확히 1건.
- store unique mapping: Codex client/server attribution과 스캔 정의가 유일하면 실제 server/tool load 행 생성.
- store collision/unconfigured: 귀속하지 않고 action 후보 행을 만들지 않음.
- Codex indirect regret: canonical exact no-match 두 세션은 2건, legacy/substring은 0건.
- store re-ingest: 같은 session을 다시 적재해도 attributed load 1건.
- Claude hook-before와 log failure/success는 direct signal을 만들고, generic log-before·다른 client·다른 exact name·action 이전·비활성 action은 만들지 않음.
- hook+log 동일 세션을 store에 넣어 regret signal이 1건임을 확인.

### 검증 명령

```bash
npm test -- --run packages/core/test/adapters/codex/adapter.test.ts packages/core/test/regret/claudeAttempt.test.ts packages/core/test/store/observations.test.ts packages/core/test/store/v2Contracts.test.ts
npx tsc --noEmit -p packages/core/tsconfig.json
npm test
npm run build
git diff --check
git status --short
```

구현 report는 `/tmp/mcplens-v2-task14-runtime-remediation-report.md`, 독립 spec/quality review는 각각 `/tmp/mcplens-v2-task14-runtime-remediation-spec-review.md`, `/tmp/mcplens-v2-task14-runtime-remediation-quality-review.md`에 한국어로 기록한다.

## Wave와 merge gate

세 제품 파일이 ingest 계약을 함께 바꾸므로 한 worktree에서 직렬 구현한다.

```text
Wave RR1: adapter implementer 구현과 표적 회귀
  -> 독립 spec review
  -> 독립 quality review
  -> root가 표적 테스트 + core 타입체크 + 전체 npm test + build + diff-check 재확인
  -> 한국어 원자 commit
  -> main --no-ff 통합과 integration ledger 별도 기록
Wave RR2: 새 main HEAD에서 Task 14 worktree 재생성
  -> 독립 npm ci/module resolution/read-only preflight
  -> 새 실행 직전 fingerprint와 새 backup
  -> Analyze cache 확인 → Claude/Codex action→regret→restore → 최종 독립 복구 검증
```

reviewer는 요구사항↔코드↔테스트를 양방향 추적하고 다음을 반드시 확인한다.

- Claude log fallback이 정확 action/server/tool/session/time 경계를 벗어나지 않는가.
- Codex success 판정이 output의 exact-name 구조 증거 없이 load를 귀속하지 않는가.
- underscore 충돌과 미설정 서버가 fail-closed인가.
- raw prompt/input/output/settings가 fixture, DB, report에 추가되지 않았는가.
- diff가 위 제품·테스트·fixture Files 밖을 수정하지 않는가.

하나라도 실패하면 commit·merge·새 Task 14 mutation을 중단하고 `CHANGES_REQUIRED` 또는 `BLOCKED`로 보고한다.

## Task 14 재개 gate

1. remediation integration SHA가 ledger에 있고 새 main HEAD의 조상인지 확인한다.
2. 현재 Task 14 worktree/branch와 이번 backup을 재사용하지 않는다. 결과 증적으로만 보존한다.
3. 새 main HEAD에서 Task 14 worktree를 다시 만들고 독립 `npm ci`, package resolution, 표적/전체 회귀, DB·process·identity read-only preflight를 처음부터 실행한다.
4. mutation 직전 당시 현재 파일 fingerprint를 다시 잡고 새 timestamp backup을 만든다.
5. Claude action 뒤 새 세션에서 hook이 없어도 정확 transcript 결과로 direct regret 1건이 생기고 restore 뒤 성공해야 한다.
6. Codex exact successful search가 실제 zero-call tool row와 action eligibility를 만들고, action 뒤 서로 다른 두 새 세션 no-match가 indirect regret 2건을 만든 뒤 restore 후 search 가능해야 한다.
7. 어떤 단계든 fail-closed 조건을 벗어나면 action을 실행하지 않고 finally 복구 후 단계별 FAIL로 보고한다.
