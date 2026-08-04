# Wave 3 결함 E 보정 구현 계획 — Codex exact search 인식 확장

4차 실환경 E2E(`/tmp/mcplens-v2-e2e-report-4th.md`)가 결함 A·D 보정 이후에도 남은 문제를 하나
발견했다. Codex에서 한 번도 호출되지 않은 툴은 전역 비활성화 액션 후보가 절대 될 수 없다.

기점 커밋은 이 계획서를 커밋한 시점의 HEAD다.

## 관측된 사실

`engine.ts:69`는 `serverName == null`인 로드를 매트릭스 행 집계에서 제외한다(의도된 동작 —
서버 귀속 불가 로드를 행 대상으로 두면 존재하지 않는 서버가 생긴다). `engine.ts:154`는
`callCount > 0 || loadedSessionCount > 0`을 툴 노출 조건으로 요구한다. 두 조건이 겹치면:
**codex에서 한 번도 호출 안 된 툴은, 로드 이벤트가 있어도 그 로드의 `serverName`이 null로
남는 한 트리에 절대 나타나지 않는다.**

codex의 로드 이벤트는 code-mode 검색(`ALL_TOOLS.filter(...)` 스크립트 실행)에서 나온다.
`adapter.ts`의 `extractExactCanonicalSearch`가 입력 스크립트에서 정확히
`ALL_TOOLS.filter(x => x.name === "리터럴")`(또는 `.find`) 형태의 **단일 리터럴 동등비교**만
인식하고, 인식에 성공한 경우에만 `classifySearchOutput`으로 출력을 검사해 이름을 뽑는다.
인식에 실패하면(예: `.includes()`, 여러 조건, 변수 경유 등) 그 호출은 출력이 무엇이든 상관없이
바로 `(code-mode-search)` 제네릭으로 남고 이름 추출 자체를 시도하지 않는다.

실기기 codex 로그(342개 세션 파일)를 이 입력 인식 규칙과 `classifySearchOutput`의 판정
로직만으로 재현해 집계한 결과(원문은 저장하지 않았다 — 분류 결과와 구조적 카운트만 집계):

- `ALL_TOOLS` 관련 검색 시도 100건 중 위 단일 리터럴 패턴에 걸리는 건 **4건(4%)**뿐이다.
  나머지 96%는 입력 인식 단계에서 걸러져 출력을 검사조차 안 한다.
- 그 4건 중 2건은 성공(canonical 이름 추출), 2건은 실패했다. 실패한 2건은 원문 없이 라인
  길이·패턴만 봤을 때 여러 줄짜리 잡다한 출력이었다 — 이건 `classifySearchOutput`이 설계대로
  fail-closed 작동한 것이지 버그가 아니다.

즉 병목은 출력 판정의 엄격함이 아니라 **입력 패턴 인식의 좁음**이다. 모델이 검색 스크립트를
어떻게 짜든(넓은 조건이든 좁은 조건이든), **출력이 유일하고 형태가 온전한 툴 정의 하나**라면
그 자체가 "이 툴 하나가 로드됐다"는 충분한 증거인데, 지금 코드는 입력이 그 특정 리터럴
동등비교 모양이 아니면 출력을 보지도 않는다.

## 설계 판단: 성공 판정을 입력 패턴이 아니라 출력 형태로 옮긴다

`classifySearchOutput`은 이미 "정의 증거가 정확히 1개, 배열 길이 1, 모호함 없음, 취소·에러
없음"을 요구하는 엄격한 구조 검증을 하고 있다. 지금 문제는 이 검증에 들어가기도 전에 입력
패턴 게이트가 96%를 걸러낸다는 것이다.

바꾸는 것: 입력이 정확히 어떤 리터럴을 검색했는지 미리 알고 있으면(`expectedExactToolName`)
지금처럼 "출력의 `name`이 그 리터럴과 정확히 같아야" 성공으로 인정한다(기존 동작 그대로,
회귀 없음). 입력 인식이 실패해 모르면(`null`), "출력의 `name` 자체가 canonical
`mcp__server__tool` 형태이고 정의 shape가 온전하면" 성공으로 인정하고 **그 이름을 출력에서
직접 가져온다** — 입력에서 무엇을 검색했는지 추측하지 않는다.

**서버/툴 분리는 손대지 않는다.** 어댑터는 지금처럼 `serverName: null`,
`toolName: <canonical 문자열>`만 내보낸다. 실제 분리는 `store.ts`의
`attributeCodexExactLoad`가 그대로 담당한다 — 이 함수는 이미 스캔된 `tool_definitions`와
`client_servers`(codex에 실제 설정된 서버 목록)를 대조해서, 후보가 정확히 하나로 좁혀질 때만
분리하고, 모호하거나(`mcp__atlas__deep__lookup`처럼 두 가지로 나뉠 수 있는 이름) 설정에 없는
서버면 그대로 버린다(`packages/core/test/store/observations.test.ts:602`가 이 안전장치를
이미 검증한다). 이 계획은 이 로직을 건드리지 않는다 — 어댑터가 더 자주 canonical 이름을
내보내게만 바꾸면, store의 기존 검증이 자동으로 더 많이 일하게 된다.

**대가**: 입력 패턴을 몰라도 성공을 인정하므로, 모델이 완전히 무관한 스크립트를 짜서 우연히
`mcp__server__tool` 모양의 `name`과 `description`을 가진 JSON 객체 하나를 출력했을 때도
성공으로 오인할 이론적 여지가 있다. 다만 이 경로는 `custom_tool_call`의 입력에 `ALL_TOOLS`
문자열이 포함된 호출로만 게이트돼 있고(`adapter.ts:70`, 이번 계획에서 바꾸지 않음), 그 안에서도
정의 shape 검증(이름+설명 또는 스키마)을 그대로 요구하므로 위험은 기존 성공 경로와 동일한
수준이다.

## 변경: `packages/core/src/adapters/codex/adapter.ts`

### 변경 1: `MCP_NAME`은 필요 없다 — 분리는 store가 한다

어댑터에 서버/툴 분리 정규식을 추가하지 않는다. `isCanonicalMcpToolName`(이미 있음, 245행
근처)만 재사용한다.

### 변경 2: `classifySearchOutput`과 `isExactDefinition`을 이름 반환 방식으로 바꾼다

현재(047ee32 기준) `classifySearchOutput(output, exactToolName: string)`과
`isExactDefinition(value, exactToolName: string): boolean`을 아래로 교체한다.

```ts
type SearchOutputClassification =
  | { kind: 'success'; toolName: string }
  | { kind: 'no-match' }
  | { kind: 'generic' };

/** Output은 block별 구조만 분류한다. 원문 연결이나 sentinel 부분 문자열 탐색은 하지 않는다. */
function classifySearchOutput(
  output: unknown, expectedExactToolName: string | null,
): SearchOutputClassification {
  const parts = outputParts(output);
  let malformed = false;
  let cancellationOrError = false;
  let ambiguousJson = parts.hasUnsupportedPart;
  const evidence: Array<'definition' | 'empty-array' | 'sentinel'> = [];
  let definition: unknown[] | null = null;

  for (const text of parts.texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      if (evidence.length > 0) { ambiguousJson = true; continue; }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) evidence.push('empty-array');
          else { evidence.push('definition'); definition = parsed; }
        } else {
          ambiguousJson = true;
        }
      } catch { malformed = true; }
    } else {
      if (hasCancellationOrError(text)) cancellationOrError = true;
      else if (isNeutralExecutionMetadata(text)) {
        if (evidence.length > 0) ambiguousJson = true;
      } else if (isAllowedNoMatchSentinel(text)) {
        if (evidence.length > 0) ambiguousJson = true;
        else evidence.push('sentinel');
      }
      else ambiguousJson = true;
    }
  }

  if (malformed || cancellationOrError || ambiguousJson) return { kind: 'generic' };
  if (evidence.length !== 1) return { kind: 'generic' };
  if (evidence[0] === 'definition') {
    if (definition?.length !== 1) return { kind: 'generic' };
    const name = validDefinitionName(definition[0], expectedExactToolName);
    return name !== null ? { kind: 'success', toolName: name } : { kind: 'generic' };
  }
  // sentinel(TOOL_NOT_FOUND) evidence는 "무엇을 찾다가 없었는지"를 알 때만 의미가 있다.
  // 입력 패턴을 몰라 expectedExactToolName이 없으면 no-match로 기록할 대상이 없다.
  return expectedExactToolName !== null ? { kind: 'no-match' } : { kind: 'generic' };
}

/**
 * 반환된 정의가 유효한 단일 MCP 툴 정의인지 확인하고, 유효하면 그 이름을 돌려준다.
 *
 * expectedExactToolName이 있으면(입력이 단일 리터럴 exact 검색이었으면) 그 이름과
 * 정확히 같아야 한다 — 기존 동작 그대로. 없으면(입력 인식이 실패했거나 애초에 넓은
 * 검색이었으면) definition.name 자체가 canonical `mcp__server__tool` 형태인지만
 * 검증한다. 서버/툴을 여기서 분리하지 않는 이유: `mcp__atlas__deep__lookup`처럼
 * 두 가지로 나뉠 수 있는 이름은 실제 설정된 서버 목록과 대조해야만 안전하게 풀 수
 * 있고, 그 대조는 store.attributeCodexExactLoad가 이미 한다.
 */
function validDefinitionName(value: unknown, expectedExactToolName: string | null): string | null {
  if (value === null || typeof value !== 'object') return null;
  const definition = value as Record<string, unknown>;
  if (typeof definition.name !== 'string') return null;
  if (expectedExactToolName !== null) {
    if (definition.name !== expectedExactToolName) return null;
  } else if (!isCanonicalMcpToolName(definition.name)) {
    return null;
  }
  const hasSchema = typeof definition.description === 'string'
    || hasObjectSchema(definition.inputSchema) || hasObjectSchema(definition.input_schema)
    || hasObjectSchema(definition.schema);
  return hasSchema ? definition.name : null;
}
```

`hasCancellationOrError`, `isNeutralExecutionMetadata`, `isAllowedNoMatchSentinel`,
`outputParts`, `hasObjectSchema`, `isCanonicalMcpToolName`은 그대로 둔다.

### 변경 3: `custom_tool_call_output` 핸들러에서 입력 게이트를 없앤다

`parseFile` 안의 `else if (t === 'custom_tool_call_output')` 블록(약 86~107행)을 아래로
교체한다. 지금은 `exactSearchCallIds.get(callId)`가 있을 때만(`exactToolName !== undefined`)
분류를 시도한다 — 이 게이트를 없애고 `idx !== undefined`(= 이 호출이 ALL_TOOLS 검색이었음)만
확인한다.

```ts
      } else if (t === 'custom_tool_call_output') {
        const callId = p.call_id ?? rec.call_id;
        const idx = typeof callId === 'string' ? codeModeCallIds.get(callId) : undefined;
        if (idx === undefined) continue;
        const text = extractOutputText(p.output ?? rec.output);
        if (text) toolLoads[idx].loadedTokens = countTokens(text);

        const expectedExactToolName = typeof callId === 'string'
          ? exactSearchCallIds.get(callId) ?? null : null;
        const output = p.output ?? rec.output;
        const classification = classifySearchOutput(output, expectedExactToolName);
        if (classification.kind === 'success') {
          toolLoads[idx].toolName = classification.toolName;
        } else if (classification.kind === 'no-match') {
          toolSearchAttempts.push({
            sessionId,
            exactToolName: expectedExactToolName!,
            observedAt: rec.timestamp ?? startedAt ?? '1970-01-01T00:00:00.000Z',
            noMatch: true,
          });
        }
      } else if (t === 'token_count') {
```

`for...of` 루프 안이므로 `if (idx === undefined) continue;`로 조기 반환한다(기존은 `if`
중첩이었다). `codeModeCallIds`, `exactSearchCallIds` 채우는 `custom_tool_call` 분기(67~85행)는
바꾸지 않는다 — `extractExactCanonicalSearch`는 여전히 no-match 기록에 필요하다.

## 테스트: `packages/core/test/adapters/codex/adapter.test.ts`

기존 테스트는 전부 그대로 통과해야 한다(아래 표로 근거를 남긴다 — 임의로 고치지 않는다).

| 기존 테스트 | 영향 | 이유 |
|---|---|---|
| `정확한 단일 정의 output은...` (104행) | 없음 | 입력이 단일 리터럴 `===`라 `expectedExactToolName`이 그대로 있음 — 기존과 동일 분기 |
| `취소·malformed·중복 exact output은...` (118행) | 없음 | 전부 단일 리터럴 `===` 입력 — `expectedExactToolName` 있음 |
| `...broad output은 generic load로 남긴다` (140행) | 없음 | 단일 리터럴 `===` 입력, 출력이 2건이라 `evidence.length!==1`에서 걸림 |
| `broad name search는... generic load로 남긴다` (151행) | 없음 | `.includes()` 입력(→ `expectedExactToolName: null`)이지만 출력 `{"name":"..."}` 에 `description`/스키마가 없어 `hasSchema`에서 걸림. **이 테스트가 새 코드에서도 여전히 통과하는 게 핵심 회귀 감시 지점**이다 |
| `canonical .includes no-match는...` (162행) | 없음 | `expectedExactToolName: null`이므로 sentinel evidence가 나와도 `no-match`가 아니라 `generic`으로 남음(새 분기의 마지막 줄) — `toolSearchAttempts` 여전히 빈 배열 |
| `canonical literal equality no-match는...` (173행) | 없음 | 단일 리터럴 `===` 입력이라 `expectedExactToolName` 있음 — 기존과 동일 |
| 주석/문자열 fake, nested, 비정상 metadata 등 대부분 | 없음 | 전부 단일 리터럴 `===` 입력 케이스만 다룸 |
| `unterminated block comment 뒤 exact-looking text는...` (314행) | **있음 — 재작성 필요** | 이 케이스만 예외다. `maskJavaScript`가 안전하게 포기해 `extractExactCanonicalSearch`가 `null`을 반환하는데, 이건 "입력이 안전하지 않아 인식 실패"이지 "단일 리터럴 `===`"이 아니다. 즉 `expectedExactToolName: null`이 되어 넓은 검색과 같은 신호로 합쳐진다. 코멘트에 숨은 리터럴이 exact 검색 대상으로 새어나가는 것(no-match 오귀속)은 여전히 막히지만, 출력이 온전한 단일 정의(`[{"name":"mcp__atlas__lookup","description":"anonymous"}]`)인 경우는 이제 성공으로 분류된다 — 실제로 미종료 코멘트가 있으면 진짜 JS 실행 자체가 문법 에러이므로 "깨진 입력 + 깨끗한 성공 출력"은 현실에서 나올 수 없는 가상 조합이라, 이 완화는 안전하다고 판단한다. 이 테스트를 성공 케이스(정의 출력)와 no-match 케이스(TOOL_NOT_FOUND 출력, 여전히 generic)로 나눠 다시 쓴다. |

새로 추가한다 — 이번 보정의 사양이다.

```ts
  it('넓은 조건 검색이어도 온전한 단일 정의를 반환하면 exposed tool name을 뽑는다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-exact', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-exact', output: [{ type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"Look up a record"}]' }] } }),
    ].join('\n');

    const r = a.parseFile('/fake/broad-exact.jsonl', content);

    expect(r.toolLoads).toEqual([{
      sessionId: r.session.sessionId, serverName: null,
      toolName: 'mcp__atlas__lookup', loadedTokens: expect.any(Number),
    }]);
    expect(r.toolSearchAttempts ?? []).toEqual([]);
  });

  it('넓은 조건 검색이 canonical 형태가 아닌 이름을 반환하면 generic으로 남긴다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-noncanonical', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-noncanonical', output: [{ type: 'input_text', text: '[{"name":"atlas-lookup","description":"Look up a record"}]' }] } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad-noncanonical.jsonl', content).toolLoads)
      .toMatchObject([{ toolName: '(code-mode-search)' }]);
  });

  it('넓은 조건 검색이 정의를 2건 반환하면 여전히 generic이다', () => {
    const content = [
      JSON.stringify({ payload: { type: 'custom_tool_call', call_id: 'broad-multi', input: 'ALL_TOOLS.filter(x => x.name.includes("atlas"))' } }),
      JSON.stringify({ payload: { type: 'custom_tool_call_output', call_id: 'broad-multi', output: [{ type: 'input_text', text: '[{"name":"mcp__atlas__lookup","description":"a"},{"name":"mcp__atlas__other","description":"b"}]' }] } }),
    ].join('\n');

    expect(a.parseFile('/fake/broad-multi.jsonl', content).toolLoads)
      .toMatchObject([{ toolName: '(code-mode-search)' }]);
  });
```

## 검증

- `npm test`가 전량 통과 (기존 회귀 0건 — 위 표 근거)
- `npx tsc --noEmit -p packages/core/tsconfig.json` 통과
- `packages/core/test/store/observations.test.ts`의
  `uniquely attributes an exact Codex exposed load...`,
  `does not attribute ambiguous or unconfigured Codex exposed loads`
  두 건이 수정 없이 그대로 통과하는지 확인한다 — `store.ts`를 건드리지 않았다는 직접 증거다.
- 실기기 확인은 이 태스크 범위 밖이다. 다음 회차 E2E에서 "Codex zero-call 후보가
  트리에 실제로 노출되는지"로 판정한다(관측 조건: 넓은 조건 검색 스크립트를 codex가
  실제로 작성하고, 응답이 온전한 단일 정의였을 때).

## 이 계획이 다루지 않는 것

**`packages/core/src/store/store.ts`.** 서버/툴 분리와 모호성 방어는 이미 올바르게
구현돼 있고 이번 결함의 원인이 아니었다(4차 E2E에서 시도했던 어댑터 레벨 직접 분리는
`mcp__atlas__deep__lookup` 같은 모호한 이름에서 안전장치를 깨뜨리는 것으로 확인되어
되돌렸다). 건드리지 않는다.

**입력 패턴 자체를 더 넓히는 것.** `extractExactCanonicalSearch`에 `.find()` 변형이나
2단계 스크립트(변수에 담았다가 나중에 출력)를 추가로 인식시키는 것은 이번 계획의 범위가
아니다. no-match 기록(회귀 신호 추적)에는 여전히 입력에서 정확한 검색 대상을 아는 것이
필요하므로, 이 확장은 별도로 다룬다.

## 실행 모델

파일이 하나뿐이라 터미널을 나누지 않는다. 소유 파일:
`packages/core/src/adapters/codex/adapter.ts`,
`packages/core/test/adapters/codex/adapter.test.ts`.

`packages/core/src/store/store.ts`, `packages/core/src/types.ts`,
`packages/core/src/store/schema.sql`은 수정하지 않는다.

서브에이전트 모델은 **sonnet**이다(계획서에 코드가 전량 있다).

## 사람이 할 일

프로젝트 루트에서 아래 두 줄로 기점만 확인한 뒤, 프롬프트를 붙여넣는다.

```
git log --oneline -1        # 이 계획서 커밋이어야 한다
git status --short          # 추적 파일에 예상 밖 변경이 없어야 한다
```

## 실행 프롬프트

~~~text
당신은 Wave 3 결함 E 보정의 터미널 오케스트레이터다. 목표는 Codex code-mode 검색의 exact tool 인식이 입력 패턴에 너무 좁게 걸려 있어, 호출된 적 없는 codex 툴이 전역 액션 후보로 절대 노출되지 못하는 결함을 고치는 것이다.

[1단계: 작업 공간 만들기] 다른 무엇보다 먼저 이것부터 해라.

`git rev-parse --show-toplevel`과 `pwd`가 `/Users/doo._.hyun/Study/Project/MCPLens-V2`인지, `git rev-parse --git-dir`와 `git rev-parse --git-common-dir`가 같은지 확인한다. 연결 worktree 안이면 중단하고 보고한다.

`MCPLENS_BASE=$(git rev-parse HEAD)`를 기록한다. 그 다음
  `git worktree add .claude/worktrees/mcplens-fix-e -b fix/codex-exact-search-output-shape $MCPLENS_BASE`
를 실행한 뒤 EnterWorktree 도구에 path로 `.claude/worktrees/mcplens-fix-e`를 넘겨 세션을 그 안으로 옮겨라. 같은 이름의 worktree나 브랜치가 이미 있으면 새로 만들지 말고 중단하고 보고한다.

진입 후 아래를 확인하고, 하나라도 어긋나면 중단하고 보고해라.
  - `pwd`가 그 worktree인지
  - `git log --oneline -1`이 `$MCPLENS_BASE`와 같은지
  - `test -f MCP-Lens-설계문서-v2.md`
  - `test -f docs/plans/2026-08-04-wave3-결함-e-codex-exact-search-확장-계획.md`
  - `git status --short`가 비어 있는지

`.claude/skills`와 `docs/pitfalls`는 untracked라 따라오지 않는다. 진입 직후
  `mkdir -p .claude && cp -R /Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/skills .claude/skills`
  `cp -R /Users/doo._.hyun/Study/Project/MCPLens-V2/docs/pitfalls docs/pitfalls`
를 실행한다. 이 두 경로는 worktree에서 고치지 않는다.

의존성은 이 worktree에서 `npm ci`로 직접 설치한다. 설치 후 **`npm run build`를 먼저 실행한다.** 새 worktree에는 `packages/core/dist/`가 없어 빌드를 건너뛰면 extension 테스트가 실패한다. 그 다음 `npm test`로 기준선이 전량 통과하는지 확인한다. 실패하면 코드를 고치기 전에 BLOCKED로 보고한다.

[2단계: 실행]

`docs/plans/2026-08-04-wave3-결함-e-codex-exact-search-확장-계획.md`를 처음부터 끝까지 읽고 그대로 구현한다. 서브에이전트 하나를 model sonnet으로 스폰해 맡기고, 당신은 리뷰만 한다.

자식에게 다음을 지시한다.

  계획서의 "변경" 절에 있는 변경 2·3과 "테스트" 절의 새 테스트 3건을 전부 구현한다. 소유 파일은 packages/core/src/adapters/codex/adapter.ts와 packages/core/test/adapters/codex/adapter.test.ts뿐이다. packages/core/src/store/store.ts, packages/core/src/types.ts, packages/core/src/store/schema.sql은 수정하지 않는다. 계획서의 "테스트" 절에 있는 표(기존 테스트가 왜 안 바뀌는지)를 참고해서, 기존 테스트 파일의 기존 단언은 하나도 고치지 않는다 — 하나라도 실패하면 구현이 계획과 다르다는 뜻이므로 임의로 기존 테스트를 바꾸지 말고 원인을 보고한다. 유닛테스트는 픽스처와 인메모리 데이터만 쓴다. 실기기 자원은 건드리지 않는다. 끝나면 `npm run build`, `npm test`, `npx tsc --noEmit -p packages/core/tsconfig.json`을 실행하고 결과를 보고한다. 커밋·merge·push는 하지 않는다.

자식이 끝나면 당신이 검증한다. `git diff --stat`으로 소유 파일 밖 변경이 0건인지 확인한다. `git diff packages/core/test/adapters/codex/adapter.test.ts`를 보고 기존 단언이 하나도 안 바뀌고 새 테스트만 추가됐는지 직접 확인한다. `npm test` 전량 통과, tsc 통과를 확인한다. `packages/core/test/store/observations.test.ts`가 이 변경과 무관하게 그대로 통과하는지(수정 없이) 별도로 확인한다. 하나라도 어긋나면 고치게 하고 다시 검증한다.

전부 통과하면 한국어로 원자적 커밋 하나를 만든다. 커밋 메시지는 실기기 관측(exact 패턴이 좁아 100건 중 4건만 후보가 됐다는 것)과 판정 기준을 입력 패턴에서 출력 형태로 옮긴 이유, store.ts는 손대지 않은 이유를 담는다. push는 하지 않는다.

마지막에 사용자에게 브랜치명, 커밋 SHA, 검증 결과, 남은 위험(입력 패턴을 더 넓히는 후속 작업이 범위 밖으로 남아 있다는 것)을 보고한다.
~~~

## 통합 게이트

1. 브랜치가 기점을 포함하는지 확인한다
2. `npm run build && npm test` 전량 통과를 확인한다
3. 통합 SHA를 `docs/task-integration-ledger.tsv`에 원장 키 `14-codex-exact-search-remediation`으로 기록한다

## 다음 회차 E2E 판정 기준

이 보정이 통합되면 다음 실환경 E2E에서 아래가 새 합격 기준이 된다.

**Codex zero-call 후보 노출.** 실제 codex 세션에서 넓은 조건의 code-mode 검색(예:
`.includes()`, 여러 조건)으로 어떤 툴 하나의 정의를 온전히 로드하되 그 툴을 호출하지는
않았을 때, 그 툴이 매트릭스 트리에 노출되고(`loadedSessionCount > 0`), zero-call이면서
`remove`/`high` 조건을 만족하면 `Disable Globally`가 뜨는지 확인한다. 4차 E2E가 이 경로를
구조적으로 막혀 있다고 판정했던 지점이다.
