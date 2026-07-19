# Claude Code 툴 단위 Remove/Add (deny 토글) — 설계 문서

> 매트릭스 트리에서 툴을 우클릭해 Remove(✕, 호출 차단) / Add(✓, 복원)하는 기능.
> 대상 클라이언트는 **Claude Code만** (codex·gemini-cli는 이번 범위 제외).

**날짜:** 2026-07-20
**상태:** 승인됨 (사용자 결정 2건 반영: deny 위치 = 유저 전역 `~/.claude/settings.json`, source of truth = settings.json 자체)

---

## 1. 목표와 동작

트리의 툴 노드를 우클릭 → **Remove** 선택:

1. `~/.claude/settings.json`의 `permissions.deny` 배열에 `mcp__<server>__<tool>` 추가
2. 트리 아이콘이 ✕(`close`)로 바뀜, description에 상태 반영
3. Claude Code **새 세션부터** 해당 툴 호출이 차단됨 (토스트로 안내)

✕ 상태의 툴을 우클릭 → **Add** 선택: deny 항목 제거, 아이콘이 기존 recommendation 아이콘(✓ 등)으로 복원.

**단방향 데이터 흐름:** settings.json이 유일한 원본(source of truth).
트리 빌드 시 deny 목록을 읽어 표시를 파생하고, Remove/Add는 settings.json을 수정할 뿐이며,
파일 워처가 변경을 감지해 트리를 리프레시한다. 사용자가 손으로 settings.json을
고쳐도 트리에 그대로 반영된다. 별도 상태 저장소 없음 → 동기화 어긋남 원천 불가.

## 2. 범위 제외 (YAGNI)

- codex·gemini-cli 트리에는 메뉴 미노출 (contextValue를 claude-code 하위 툴에만 부여)
- 서버 단위 deny(`mcp__<server>` 전체 차단) 미지원 — 툴 단위만
- deny 이력(누가 언제 껐는지) 기록 없음
- 프로젝트 스코프 settings(`.claude/settings.json`, `settings.local.json`) 미지원

## 3. 아키텍처

기존 원칙 그대로: **능력은 core에, extension은 얇은 표면.**

### 3-1. core 신규 모듈 `packages/core/src/permissions/claudeSettings.ts`

`vscode` import 금지. 공개 API 3개:

```ts
/** ~/.claude/settings.json 경로. paths.ts 관례(os.homedir + path.join) 준수 */
export function claudeSettingsPath(): string;

/** permissions.deny에서 `mcp__`로 시작하는 규칙 문자열을 원형 그대로 집합으로 반환.
 *  파일 없음 → 빈 Set. JSON 파싱 실패 → throw (호출부가 에러 표시). */
export function readDeniedMcpTools(settingsPath: string): Set<string>;

/** deny 규칙 추가/제거. 멱등(이미 있으면/없으면 no-op).
 *  다른 키·다른 deny 항목은 그대로 보존. */
export function denyMcpTool(settingsPath: string, server: string, tool: string): void;
export function allowMcpTool(settingsPath: string, server: string, tool: string): void;
```

쓰기 안전장치 (원본 클라이언트 파일 보호 — "로그 읽기 전용" 원칙의 연장):

- **파싱 실패 시 절대 덮어쓰지 않는다.** JSON.parse가 throw하면 그대로 전파, 쓰기 없음.
- 쓰기 직전 `settings.json.mcplens.bak`으로 백업 (매 쓰기마다 갱신).
- tmp 파일에 쓴 뒤 rename하는 원자적 쓰기.
- 파일이 없으면 `{ "permissions": { "deny": [...] } }`로 새로 생성.
- 직렬화는 `JSON.stringify(obj, null, 2)` — 주석 없는 표준 JSON 전제
  (Claude Code settings.json은 표준 JSON).

deny 규칙 문자열 형식: `mcp__<server>__<tool>` (Claude Code permissions 규칙 형식).
서버명에 `__`가 포함될 수 있으므로 규칙 문자열을 쪼개서 해석하지 않는다 —
`buildTree`가 매트릭스의 각 (server, tool)로 `mcp__${server}__${tool}`을 조립해
집합 멤버십으로만 대조한다. 매트릭스에 없는 deny 항목은 자연히 무시된다(표시 없음).

### 3-2. extension 변경

| 파일 | 변경 |
|---|---|
| `src/matrixTree.ts` | `LensNode`에 `client?: ClientId`, `serverName?`, `toolName?`, `enabled?: boolean` 추가. `buildTree(input, deniedTools?)` — denied 집합을 받아 `client === 'claude-code'`인 툴 노드에만 `enabled` 산출. denied 툴은 description 끝에 `· 차단됨` 표기 |
| `src/lensTreeProvider.ts` | 툴 노드에 `contextValue` 부여: claude-code 하위만 `'mcpTool-enabled'` / `'mcpTool-disabled'`. disabled면 `ThemeIcon('close')`, enabled면 기존 `ACTION_ICON` 유지 |
| `src/extension.ts` | 커맨드 2개 등록(core API 호출 → 트리 리빌드), `~/.claude/settings.json` 대상 `FileSystemWatcher`(create/change) → 리빌드, Remove 성공 시 정보 토스트 "새 Claude Code 세션부터 적용됩니다", core throw 시 에러 토스트(파일은 미변경임을 명시) |
| `package.json` | `commands`: `mcp-lens.removeTool`("MCP Lens: 툴 차단"), `mcp-lens.addTool`("MCP Lens: 툴 복원"). `menus["view/item/context"]`: `view == mcpLens.matrix && viewItem == mcpTool-enabled` → removeTool, `viewItem == mcpTool-disabled` → addTool |

### 3-3. 에러 처리 요약

| 상황 | 동작 |
|---|---|
| settings.json 없음 | 읽기: 빈 deny로 간주. 쓰기: 새로 생성 |
| settings.json JSON 깨짐 | core가 throw → extension이 에러 토스트, **파일 미변경** |
| 이미 deny된 툴에 다시 remove | 멱등 no-op |
| 사용자가 손으로 settings 수정 | 워처가 감지 → 트리 자동 반영 |
| 트리에 없는 서버의 deny 항목 | 무시 (트리 표시에 영향 없음) |

## 4. 테스트 전략

- **core 유닛테스트** (`packages/core/test/permissions.test.ts`): temp 디렉토리에 픽스처 settings.json 복사 후 read/deny/allow 검증. 케이스: 빈 파일·파일 없음·기존 deny 보존·멱등성·깨진 JSON에서 throw+미변경·백업 생성. 실기기 `~/.claude` 접근 금지 (터미널 병렬 안전).
- **extension 유닛테스트** (`packages/extension/test/matrixTree.test.ts` 확장): `buildTree`에 denied 집합 주입 → `enabled` 플래그·claude-code 한정 적용 검증. vscode 비의존(기존 관례).
- **E2E 스모크 (직렬 전용)**: 실기기 settings.json 백업 → 확장에서 툴 remove → 새 Claude Code 세션에서 해당 툴 호출 시도가 거부되는지 확인 → add로 복원 → 원본 복구.

픽스처: `fixtures/claude-settings/` 신규 — `basic.json`(deny 있음), `no-permissions.json`, `broken.json`.

---

## 5. 터미널 운용 계획 ★ 병렬 실행 분배

### 5-1. 의존성 그래프

```
Wave 0 (직렬 — 오케스트레이터 세션이 직접 수행, 서브에이전트 불필요, 소규모)
  Task 0 공유 계약: LensNode 필드 확장 + core index.ts export 선언 + fixtures/claude-settings/ 픽스처 3종
        │  (여기서 계약이 확정·커밋됨 — 이후 두 트랙은 서로 완전 독립)
        ├──────────────────────────────┐
Wave 1  ▼                              ▼          (2개 완전 병렬)
  [터미널 A] Task 1 core permissions   [터미널 B] Task 2 extension UI
  모듈 + 유닛테스트                     메뉴·커맨드·아이콘·워처 + 유닛테스트
        └──────────────┬───────────────┘
Wave 2                 ▼               (직렬 — 실기기 자원 사용)
  [터미널 1개] Task 3 E2E 스모크 + 머지 게이트
```

### 5-2. 태스크별 터미널·파일 소유권·모델

| 태스크 | 터미널/worktree | 브랜치 예시 | Files (이 목록 밖 수정 금지) | 서브에이전트 모델 |
|---|---|---|---|---|
| Task 0 공유 계약 | 메인 (오케스트레이터 직접) | `main` 또는 `feat/deny-contract` | `packages/extension/src/matrixTree.ts`(LensNode 타입만), `packages/core/src/index.ts`(export 1줄, 구현은 빈 스텁), `packages/core/src/permissions/claudeSettings.ts`(시그니처 스텁), `fixtures/claude-settings/*` | — (직접) |
| Task 1 core permissions | **터미널 A** | `feat/deny-core` | `packages/core/src/permissions/claudeSettings.ts`(스텁 → 구현), `packages/core/test/permissions.test.ts` | sonnet |
| Task 2 extension UI | **터미널 B** | `feat/deny-ext` | `packages/extension/src/matrixTree.ts`(buildTree 로직), `src/lensTreeProvider.ts`, `src/extension.ts`, `packages/extension/package.json`, `packages/extension/test/matrixTree.test.ts` | sonnet |
| Task 3 E2E 스모크 | 터미널 1개 (A·B 머지 후) | `main` | 코드 수정 없음 원칙 — 발견된 버그만 해당 파일 수정 | opus |

**병렬 안전 근거:**

- Task 1과 2는 파일이 하나도 겹치지 않는다. 유일한 접점(`LensNode` 타입, core API 시그니처)은 Wave 0에서 확정·커밋되어 양쪽 모두 읽기만 한다.
- Task 2는 core 구현 완성을 기다리지 않는다 — Wave 0의 시그니처 스텁에 대해 컴파일되고, `buildTree` 테스트는 denied 집합을 직접 주입하므로 core 동작과 무관.
- 두 태스크의 유닛테스트는 temp 디렉토리·주입 데이터만 사용 → 실기기 `~/.claude`·공유 DB를 건드리지 않아 터미널 병렬 안전.

**직렬이어야만 하는 것:**

- Task 0 (계약이 흔들리면 양 트랙 재작업)
- Task 3 (실기기 `~/.claude/settings.json`과 실제 Claude Code 세션을 사용 — 반드시 A·B 머지 후 단독 실행, 시작 전 settings.json 수동 백업)

### 5-3. 오케스트레이터 체크리스트 (머지 게이트)

- [ ] Wave 0: 계약 커밋 확인 (양 터미널이 이 커밋에서 worktree 생성)
- [ ] Wave 1 리뷰: 각 태스크 테스트 통과 + Files 목록 준수 + core에 vscode import 없음
- [ ] 머지 순서: Task 1 → Task 2 (충돌 없어야 정상; 충돌 시 계약 위반 신호)
- [ ] Wave 2: E2E 통과 후 main 머지

---

## 6. 남은 결정 없음

사용자 결정 2건(deny 위치, source of truth)은 반영 완료. 구현 계획 단계로 넘어갈 준비됨.
