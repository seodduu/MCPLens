# Codex 코드모드 load 귀속 보정 구현계획

작성: 2026-08-05. 기준 문서: `MCP-Lens-설계문서-v2.md`, `CLAUDE.md`.

**한 줄:** Codex 코드모드에서 검색으로 실제 로드된 툴이 매트릭스에 나타나지 않는 두 결함을 고친다.
검색 출력에 정의가 여러 개 실려도 한 개가 아니면 통째로 버리는 문제(B)와, 툴 이름을 얻고도
서버 귀속에 실패하면 영구히 null로 굳는 문제(A)다.

---

## 1. 배경과 실측 근거

Claude Code는 zero-call 툴도 매트릭스에 뜬다. 로드 이벤트에 서버 identity가 붙기 때문이다.
실 DB 확인: `notion-update-page`는 호출 0회지만 `tool_loads`에 `server_name='notion'`으로 2건이
있어 `visibleMatrixRows`(`packages/core/src/engine/engine.ts:154`)의
`callCount > 0 || loadedSessionCount > 0`을 통과한다.

Codex는 통과하지 못한다. 실 DB의 codex load 집계:

| server_name | tool_name | 건수 |
|---|---|---|
| (null) | `(code-mode-search)` | 64 |
| (null) | `mcp__lenstest2__track_flight` | 2 |
| (null) | `mcp__node_repl__js_reset` | 2 |
| (null) | `mcp__lenstest2__get_weather` | 1 |

`engine.ts:69`가 `serverName == null`인 load를 행 대상에서 제외하므로 **한 건도 매트릭스에 닿지
않는다.** `node_repl/js_reset`은 실사용에서 두 번 검색됐는데도 지금 트리에 없다.

### 1-1. 검색 모양 실측 (2026-08-05, `~/.codex/sessions` 359개 세션 전수)

`ALL_TOOLS` 검색 호출 117건 중 57건은 MCP Lens 자체 개발 세션의 자기참조(패치 본문·픽스처에
`ALL_TOOLS` 문자열이 들어간 것)라 배제하고, 실제 검색 60건의 분포는 다음과 같다.

| 건수 | 입력 모양 | 현행 판정 |
|---|---|---|
| 48 (80%) | 부분일치 (`x.name.includes(...)`, `toLowerCase().includes(...)`, description 병행) | 이름 추출 실패 |
| 5 (8%) | `x.name === "리터럴"` | 성공 |
| 5 | 검색이 아닌 호출 (grep 스크립트 등) | 해당 없음 |
| 2 | `name ===` 이나 변수 경유 | 실패 |

부분일치 48건 + exact 5건 = 53건의 **출력** 모양은 다음과 같다.

| 건수 | 출력 모양 | 이 계획 이후 |
|---|---|---|
| **35** | `[{...}, {...}]` 정의 객체 배열 원문 | **복구 대상** |
| 6 | `{ "matches": [...] }` 객체 래퍼 | 비범위 (4장) |
| 6 | `Warning: truncated output` | 비범위 (4장) |
| 4 | 배열이지만 정의 객체 아님 | 대상 아님 |
| 2 | 비 JSON 문자열 | 대상 아님 |

즉 **입력 정규식을 넓히는 것은 답이 아니다.** 부분일치 검색은 어느 툴을 지목한 것이 아니므로
입력만으로 귀속하면 오탐이 된다. 답은 이미 결함 E 보정이 잡은 방향("판정을 입력 패턴에서 출력
형태로 옮긴다")을 끝까지 적용하는 것이다. 출력에 정의가 N개 실려 있으면 그 N개가 실제로 로드된
툴이고, 각 정의 원문의 토큰이 실제 지불 비용이다.

### 1-2. 귀속이 null로 굳는 경로

`packages/core/src/store/store.ts:149 attributeCodexExactLoad`는 **수집 시점에**
`tool_definitions`와 대조해 `mcp__server__tool`을 분해한다. 관측이 스캔보다 먼저 들어오면 후보가
0건이라 null로 저장되고, 이후 스캔이 들어와도 소급 보정 경로가 없다. 실 DB가 정확히 그 상태다.

| | 시각 |
|---|---|
| `mcp__node_repl__js_reset` 검색 관측 | 2026-08-03T19:07:42Z, 19:48:02Z |
| `node_repl` 정의 스캔 | 2026-08-04T11:57:07Z |

로그 파일은 `file_cursors`로 재읽기가 억제되므로 재수집으로도 회복되지 않는다.

---

## 2. 완료 조건

1. `npm test` 전량 통과 (`vitest.config.ts`의 `include: ['packages/*/test/**/*.test.ts']`).
2. `npx tsc --noEmit -p packages/core/tsconfig.json` 통과.
3. `npx tsc --noEmit -p packages/extension/tsconfig.json` 통과.
4. 실 DB 검증: 스캔 1회 후
   `SELECT server_name, tool_name FROM tool_loads WHERE tool_name='js_reset'`가
   `node_repl|js_reset`을 반환한다.
5. 실기기 확인: VS Code 확장 트리의 codex 섹션에 `node_repl / js_reset`이 0 calls로 노출되고,
   그 화면을 **스크린샷으로 찍어 파일 경로를 보고서에 남긴다.**

---

## 3. 비범위

- `visibleMatrixRows`의 필터 조건 변경. 검색된 적 없는 codex 툴은 실비용 0이 실측으로
  확인됐으므로(2026-08-05, 서버 12툴 추가 전후 첫 턴 입력 토큰 델타 0) 숨기는 현행 동작이 맞다.
- 입력 정규식(`extractExactCanonicalSearch`) 확장. 1-1의 근거로 기각.
- 스키마 변경과 마이그레이션. 이 계획은 DDL을 건드리지 않는다.
- Claude·Gemini 어댑터. 두 클라이언트는 이 문제가 없다.

---

## 4. 고정 정책 결정

| 결정 | 값 | 근거 |
|---|---|---|
| 다중 정의 출력의 로드 인정 | 출력이 **최상위 JSON 배열**이고 원소 중 canonical MCP 정의가 1개 이상이면 그 전부를 로드로 기록 | 1-1. 실사용 53건 중 35건이 이 모양 |
| 비 canonical 원소 | 무시하고 canonical 원소만 기록 | 부분일치 검색은 내장 툴도 함께 반환한다. 이름 규칙(`mcp__server__tool`)이 MCP 여부의 유일한 판별자 |
| 정확 검색(입력 패턴 확인됨)의 판정 | 현행 유지. 원소 정확히 1개 + 이름이 기대값과 일치할 때만 성공 | 정확 검색은 지목 대상이 하나다. 느슨하게 하면 결함 E 보정이 막은 오탐이 되돌아온다 |
| 객체 래퍼 `{ "matches": [...] }` | 계속 `generic`으로 버림 | 래퍼 키는 모델이 매번 다르게 짓는다. 구조를 단정할 수 없으므로 fail-closed 유지 |
| 잘린 출력(`Warning: truncated output`) | 계속 `generic`으로 버림 | 정의가 잘렸으면 토큰 수도 정의 내용도 신뢰할 수 없다 |
| 다중 로드의 토큰 배분 | 원소별 `countTokens(JSON.stringify(원소))` | 합계가 출력 원문 토큰에 근사하면서 툴별 비용이 실제 정의 크기에 비례한다. 균등 배분은 1,058토큰 툴과 74토큰 툴을 같게 만든다 |
| 다중 로드 인정 시 집계 행 | `(code-mode-search)` 행을 남기지 않는다 | 현행 단일 성공 경로와 같다(`toolName`을 덮어쓴다). 남기면 같은 출력이 이중 계상된다 |
| 귀속 시점 | 수집 시점이 아니라 **materialize 시점**(`rebuildSession`) | 관측은 원문 보존, 해석은 파생이라는 프로젝트 원칙. 스캔이 나중에 와도 다음 materialize에서 회복된다 |
| 스캔 후 재materialize 범위 | `client='codex'` 이고 `server_name IS NULL` 이며 `tool_name LIKE 'mcp\_\_%'` 인 load를 가진 세션 | 회복 가능성이 있는 세션만 만진다. 전체 재구축은 비용이 세션 수에 비례해 커진다 |

---

## 5. 터미널 분할

**터미널 1개, worktree 1개, 브랜치 1개.** Task 1과 Task 2는 파일이 다르지만
(`adapter.ts` / `store.ts`) 같은 회귀 스펙과 같은 픽스처를 공유하고, Task 2의 검증이 Task 1의
산출(다중 로드)에 의존하므로 **순차로 실행**한다.

| 웨이브 | 태스크 | 모델 | 비고 |
|---|---|---|---|
| 1 | Task 1 어댑터 다중 정의 로드 | **opus** | 로그 파서. `CLAUDE.md` 모델 배분의 예외 조항 |
| 1 | Task 2 귀속 시점 이동과 스캔 후 회복 | **opus** | 저장 계층 상태 전이 판단 |
| 2 | 실기기 확인 (오케스트레이터 직접) | opus | 스크린샷 필수 |

---

## 6. Task 1 — 어댑터가 다중 정의 출력을 툴별 로드로 기록

**Files**
- Modify: `packages/core/src/adapters/codex/adapter.ts`
- Modify: `packages/core/test/adapters/codex/adapter.test.ts`
- Add: `fixtures/codex/tool-search-multi.jsonl`
- Add: `fixtures/codex/tool-search-multi-mixed.jsonl`

### 6-1. 타입 변경

```ts
type SearchOutputClassification =
  | { kind: 'success'; tools: Array<{ toolName: string; definitionText: string }> }
  | { kind: 'no-match' }
  | { kind: 'generic' };
```

`kind: 'success'`의 `tools`는 **길이 1 이상**을 보장한다. 0개면 `generic`을 반환한다.

### 6-2. `classifySearchOutput` 변경

`evidence[0] === 'definition'` 분기만 바꾼다. 나머지(`malformed`·`cancellationOrError`·
`ambiguousJson`·`evidence.length !== 1`·sentinel 경로)는 현행 그대로 둔다.

```ts
  if (evidence[0] === 'definition') {
    const elements = definition ?? [];
    if (expectedExactToolName !== null) {
      // 정확 검색: 지목 대상이 하나다. 현행 엄격 규칙 유지.
      if (elements.length !== 1) return { kind: 'generic' };
      const name = validDefinitionName(elements[0], expectedExactToolName);
      return name === null
        ? { kind: 'generic' }
        : { kind: 'success', tools: [{ toolName: name, definitionText: JSON.stringify(elements[0]) }] };
    }
    // 부분일치 검색: canonical MCP 정의만 골라 전부 로드로 인정한다.
    const tools: Array<{ toolName: string; definitionText: string }> = [];
    for (const element of elements) {
      const name = validDefinitionName(element, null);
      if (name !== null) tools.push({ toolName: name, definitionText: JSON.stringify(element) });
    }
    if (tools.length === 0) return { kind: 'generic' };
    // 같은 툴이 두 번 실린 출력은 한 번만 센다.
    const seen = new Set<string>();
    const unique = tools.filter((t) => (seen.has(t.toolName) ? false : (seen.add(t.toolName), true)));
    return { kind: 'success', tools: unique };
  }
```

### 6-3. `custom_tool_call_output` 처리부 변경

현행은 `toolLoads[idx].toolName`을 덮어쓴다. 다중이면 슬롯 하나로 부족하므로 첫 툴은 그 슬롯에
넣고 나머지는 뒤에 push한다. `tool_loads`에는 순서 의미가 없으므로(시각 컬럼 없음) 재배치는
안전하다.

```ts
        if (classification.kind === 'success') {
          const [first, ...rest] = classification.tools;
          toolLoads[idx].toolName = first!.toolName;
          toolLoads[idx].loadedTokens = countTokens(first!.definitionText);
          for (const tool of rest) {
            toolLoads.push({
              sessionId,
              serverName: null,
              toolName: tool.toolName,
              loadedTokens: countTokens(tool.definitionText),
            });
          }
        } else if (classification.kind === 'no-match') {
```

`loadedTokens`를 출력 원문 전체 토큰에서 **원소별 토큰으로 덮어쓴다**는 점이 현행과의 차이다.
성공 판정 전에 설정하는 `if (text) toolLoads[idx].loadedTokens = countTokens(text);`는 그대로
두어 `generic`으로 떨어진 경우의 집계 비용을 보존한다.

### 6-4. 픽스처

`fixtures/codex/tool-search-multi.jsonl`: 부분일치 입력
(`ALL_TOOLS.filter(x => x.name.includes("atlas"))`)에 출력은 canonical 정의 2개짜리 배열
(`mcp__atlas__lookup`, `mcp__atlas__search`). 각 정의에 `description`을 넣어 스키마 조건을
만족시킨다.

`fixtures/codex/tool-search-multi-mixed.jsonl`: 같은 형태이되 배열에 canonical 정의 2개와
내장 툴 원소 1개(`{"name":"exec","description":"..."}`)를 섞는다.

### 6-5. 테스트 (`packages/core/test/adapters/codex/adapter.test.ts`에 추가)

| 이름 | 단언 |
|---|---|
| `부분일치 검색 출력의 정의 N개를 각각 로드로 기록한다` | `tool-search-multi.jsonl` 파싱 결과 `toolLoads`가 2건. `toolName`이 `['mcp__atlas__lookup','mcp__atlas__search']`(순서 무관). 두 건 모두 `serverName === null`. `(code-mode-search)` 이름의 로드가 0건 |
| `다중 로드의 토큰은 원소별 정의 크기로 나뉜다` | 위 두 건의 `loadedTokens`가 각각 `countTokens(JSON.stringify(해당 정의))`와 동일. 두 값이 서로 다름(균등 배분이 아님을 고정) |
| `canonical이 아닌 원소는 로드로 세지 않는다` | `tool-search-multi-mixed.jsonl` 결과 `toolLoads` 2건. `exec`가 포함되지 않음 |
| `canonical 정의가 하나도 없으면 집계 행으로 남는다` | 배열 원소가 전부 내장 툴인 출력 → `toolLoads` 1건, `toolName === '(code-mode-search)'`, `loadedTokens`는 출력 원문 토큰 |
| `정확 검색은 원소가 2개 이상이면 여전히 generic이다` | 입력이 `x.name === "mcp__atlas__lookup"`인데 출력 배열 원소가 2개 → `toolLoads` 1건이며 `(code-mode-search)` |
| `같은 툴이 중복 실린 출력은 한 번만 센다` | 동일 정의 2개짜리 배열 → `toolLoads` 1건 |
| `객체 래퍼 출력은 계속 generic이다` | `{"matches":[{...}]}` 출력 → `(code-mode-search)` 유지 |
| `잘린 출력은 계속 generic이다` | `Warning: truncated output` 텍스트가 섞인 출력 → `(code-mode-search)` 유지 |

기존 스펙(`tool-search-success.jsonl`, `tool-search-no-match.jsonl`,
`tool-search-cancelled.jsonl`, `rollout-codemode.jsonl` 관련)은 **전부 그대로 통과해야 한다.**
하나라도 고쳐야 한다면 중단하고 보고한다.

---

## 7. Task 2 — 귀속을 materialize 시점으로 옮기고 스캔 후 회복시킨다

**Files**
- Modify: `packages/core/src/store/store.ts`
- Modify: `packages/core/test/store/*.test.ts` (귀속 관련 기존 스펙이 있는 파일)
- Add: `packages/core/test/store/codex-load-attribution.test.ts`

### 7-1. 귀속 호출 위치 이동

수집 루프(`store.ts:107`)의 `const attributed = this.attributeCodexExactLoad(observation);`를
제거하고 원본 관측을 그대로 저장한다. `directClaudeRegretSignals`에도 원본을 넘긴다
(`attributeCodexExactLoad`는 `client !== 'codex'`면 무변환이므로 Claude 경로에 영향이 없다).

`rebuildSession`의 load 기록부에서 귀속한다.

```ts
    for (const load of materialized.toolLoads) {
      const attributed = this.attributeCodexLoadName(session.client, load);
      this.run(
        `INSERT INTO tool_loads(session_id, server_name, tool_name, loaded_tokens) VALUES(?,?,?,?)`,
        [sessionId, attributed.serverName, attributed.toolName, attributed.loadedTokens]);
    }
```

`attributeCodexLoadName`은 기존 `attributeCodexExactLoad`의 판정을 `ToolLoadEvent`에 맞춰 옮긴
것이다. 조건은 동일하게 유지한다.

```ts
  /** Codex가 남긴 canonical 이름은 현재 스캔·설정에 유일하게 맞을 때만 분해한다. */
  private attributeCodexLoadName(client: string, load: ToolLoadEvent): ToolLoadEvent {
    if (
      client !== 'codex'
      || load.serverName !== null
      || load.toolName === '(code-mode-search)'
      || !load.toolName.startsWith('mcp__')
    ) return load;
    const candidates = this.select(
      `SELECT d.server_name, d.tool_name FROM tool_definitions d
       JOIN client_servers c ON c.server_name=d.server_name
       WHERE c.client='codex'`, [],
    ).filter((row) => `mcp__${row.server_name as string}__${row.tool_name as string}` === load.toolName);
    if (candidates.length !== 1) return load;
    return {
      ...load,
      serverName: candidates[0]!.server_name as string,
      toolName: candidates[0]!.tool_name as string,
    };
  }
```

`attributeCodexExactLoad`(관측용)는 **삭제한다.** 두 벌을 남기면 어느 쪽이 진실인지 갈린다.
삭제로 깨지는 기존 스펙이 있으면 새 시점 기준으로 고쳐 적되, 삭제가 아니라 이동임을 테스트
이름에 남긴다.

### 7-2. 스캔 후 회복

`upsertDefinitions`(`store.ts:252`)의 트랜잭션 끝에 회복 패스를 붙인다.

```ts
  /** 스캔이 나중에 들어와 귀속에 실패했던 codex load를 회복시킨다. */
  private reattributePendingCodexLoads(): void {
    const rows = this.select(
      `SELECT DISTINCT l.session_id FROM tool_loads l
       JOIN sessions s ON s.session_id = l.session_id
       WHERE s.client = 'codex' AND l.server_name IS NULL
         AND l.tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\'`, [],
    );
    for (const row of rows) this.rebuildSession(row.session_id as string);
  }
```

회복 가능성이 있는 세션만 만진다. 귀속에 성공하면 그 세션의 load에 `server_name`이 채워지므로
다음 스캔에서는 조회 대상에서 빠진다. 즉 이 패스는 **수렴한다.**

### 7-3. 테스트 (`packages/core/test/store/codex-load-attribution.test.ts`, `:memory:` DB)

| 이름 | 단언 |
|---|---|
| `스캔이 먼저면 수집 시점에 귀속된다` | `upsertDefinitions`로 `node_repl/js_reset` 등록 + `client_servers`에 codex 등록 후 `mcp__node_repl__js_reset` 로드를 담은 codex 세션 수집 → `tool_loads`에 `node_repl|js_reset` |
| `관측이 먼저면 일단 null로 남는다` | 정의 없이 같은 세션 수집 → `tool_loads`에 `NULL|mcp__node_repl__js_reset` |
| `나중에 스캔이 들어오면 소급 회복된다` | 위 상태에서 `upsertDefinitions` 호출 → 재조회 시 `node_repl|js_reset`. 로그 재읽기 없이 성립해야 한다 |
| `회복 패스는 두 번 돌려도 결과가 같다` | `upsertDefinitions`를 연속 2회 호출 → `tool_loads` 행 수와 내용이 1회 호출 후와 동일(멱등) |
| `후보가 2개 이상이면 귀속하지 않는다` | 두 서버가 같은 `mcp__a__b` 이름을 만들 수 있는 정의를 등록 → `server_name`이 계속 NULL |
| `codex가 아닌 클라이언트의 load는 건드리지 않는다` | claude 세션의 `notion|notion-search` 로드가 회복 패스 전후로 동일 |
| `(code-mode-search) 집계 행은 귀속 대상이 아니다` | 해당 행의 `server_name`이 계속 NULL |
| `귀속된 load는 매트릭스 행으로 나타난다` | 회복 후 `buildMatrix` 결과에 `node_repl/js_reset` 행이 있고 `loadedSessionCount === 1`, `callCount === 0` |

마지막 항목이 이 계획의 실질 완료 조건이다. 엔진까지 닿는지 확인하지 않으면 DB만 고치고 화면은
그대로인 상태를 놓친다.

---

## 8. 사람이 할 사전 확인 2줄

```bash
git log --oneline -1     # 기점 커밋 확인
git status               # 깨끗한지 확인
```

---

## 9. 실행 프롬프트 (터미널 1/1)

프로젝트 루트에서 새 터미널을 열고 아래 블록만 붙여넣는다. 이 밖에서 git 명령을 직접 실행하지
않는다.

~~~text
당신은 Codex load 귀속 보정의 터미널 오케스트레이터다. 계획서는
`docs/plans/2026-08-05-codex-load-귀속-보정-계획.md`이며 그것이 사양의 유일한 진실이다.

[1단계: 작업 공간 만들기] 다른 무엇보다 먼저 이것부터 해라.
`git rev-parse --show-toplevel`과 `pwd`로 현재 위치가 프로젝트 루트인지 확인한다. 다르면
수정하지 말고 BLOCKED로 보고한다. 이어서
  git worktree add .claude/worktrees/mcplens-codex-load-attribution -b fix/codex-load-attribution
를 실행한 뒤 EnterWorktree 도구에 path로 `.claude/worktrees/mcplens-codex-load-attribution`의
절대 경로를 넘겨 세션을 그 안으로 옮겨라. EnterWorktree를 name으로 새로 만들게 하지 마라.
진입 후 아래를 확인하고 하나라도 어긋나면 중단하고 보고해라.
  - pwd가 그 worktree인지
  - git log --oneline -1 이 루트에서 본 기점 커밋과 같은지
  - `docs/plans/2026-08-05-codex-load-귀속-보정-계획.md`와 `MCP-Lens-설계문서-v2.md`가 있는지
  - git status가 깨끗한지
gitignore 대상인 `.claude/skills`와 `docs/pitfalls`는 루트에서 `cp -R`로 worktree에 복사해라.
그다음 `npm ci`와 `npm run build`를 실행한다.

[2단계: 실행]
계획서 6장(Task 1)과 7장(Task 2)을 이 순서대로 서브에이전트에 맡긴다. 두 태스크를 동시에
스폰하지 마라. 각 서브에이전트는 model을 opus로 지정한다(로그 파서·저장 계층 상태 전이라
CLAUDE.md 모델 배분의 예외 조항에 해당한다).

각 서브에이전트에게 다음을 그대로 지시한다.
  - 계획서의 해당 장 Files 목록 밖 파일을 수정하지 마라. 특히
    `packages/core/src/types.ts`, `packages/core/src/store/schema.sql`,
    루트 설정(`package.json`, `tsconfig.base.json`, `vitest.config.ts`)은 공유 계약이다.
    안 맞으면 수정하지 말고 보고해라.
  - 테스트를 먼저 실패 상태로 고정한 뒤 구현해라. 계획서의 테스트 표에 있는 이름과 단언을
    전부 만들어라. 임의로 줄이지 마라.
  - 계획서의 필드명과 실제 픽스처가 다르면 픽스처가 진실이다. 코드를 픽스처에 맞춰라.
  - 유닛테스트는 `fixtures/` + `:memory:` DB만 쓴다. 공유 DB(`~/.mcplens/lens.db`)를 만지지 마라.
  - 완료 보고 전에 `npm test`, `npx tsc --noEmit -p packages/core/tsconfig.json`,
    `npx tsc --noEmit -p packages/extension/tsconfig.json`, `git diff --check`를 전부 돌리고
    출력을 보고서에 붙여라. 루트에서 `npx tsc --noEmit`만 도는 것은 0파일 검사라 무효다.
  - 기존 스펙을 고쳐야 통과한다면 고치기 전에 보고해라.

Task 1이 끝나면 리뷰한다. 판정 기준은 (a) 위 4개 명령이 전부 녹색, (b) 변경 파일이 계획서
Files 목록 안, (c) 기존 codex 어댑터 스펙이 수정 없이 통과. 통과하면 한국어 커밋 메시지로
태스크 단위 원자 커밋을 만든다. 실패하면 같은 서브에이전트에 수정 지시를 보낸다.

Task 2도 같은 절차로 진행한다.

[3단계: 실기기 확인] 두 태스크 모두 통과한 뒤 오케스트레이터가 직접 한다.
  1. `~/.codex/config.toml`이 측정용 임시 등록(`lenstest2`)을 담고 있으면 먼저
     `~/.codex/config.toml.measure.bak`로 원복한다. 백업이 없으면 손대지 말고 보고한다.
  2. `~/.mcplens/lens.db`를 mktemp 디렉터리에 백업하고 그 경로를 보고서에 남긴다.
  3. 이 worktree 빌드 산출물로 격리 EDH를 띄우고(`--user-data-dir`를 임시 경로로) 스캔을
     실행한 뒤, codex 섹션 트리에 `node_repl / js_reset`이 0 calls로 노출되는지 확인한다.
  4. 그 화면을 스크린샷으로 찍어 파일 경로를 보고서에 남긴다. 테스트 통과는 이 요구를
     대체하지 못한다.
  5. `sqlite3 -readonly ~/.mcplens/lens.db "SELECT server_name, tool_name FROM tool_loads
     WHERE tool_name='js_reset'"` 결과를 보고서에 붙인다.
  6. 확인이 끝나면 격리 EDH 프로세스가 남아 있지 않은지 확인한다.

[4단계: 보고] 최종 보고서를 `docs/reports/2026-08-05-codex-load-귀속-보정/보고서.md`에 쓴다.
`/tmp`에만 두지 마라. 4차 E2E 보고서가 `/tmp`에만 남아 유실 위험을 만든 전례가 있다.
보고서에는 검증 명령 출력, 스크린샷 경로, 실 DB 조회 결과, 남은 위험을 적는다.
~~~

---

## 10. 중단 조건

아래 중 하나면 진행하지 말고 보고한다.

- 기존 codex 어댑터 스펙이 수정 없이는 통과하지 않는다. 결함 E 보정이 막은 오탐 경계를
  건드렸다는 뜻이다.
- `attributeCodexExactLoad` 제거가 Claude 직접 후회 신호 스펙을 깨뜨린다.
- 회복 패스가 멱등하지 않다(연속 2회 호출에서 `tool_loads` 행 수가 달라진다).
- 실기기 확인에서 `js_reset`이 DB에는 귀속됐는데 트리에 안 뜬다. 그 경우 결함이 표시 계층에
  하나 더 있다는 뜻이므로 이 계획의 범위를 넘는다.
