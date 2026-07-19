# Claude Code MCP 서버 단위 Remove/Add (서버 비활성/복원) — 설계 문서

> 매트릭스 트리에서 **서버 노드**를 우클릭해 Remove(서버 자체를 끔 — 연결·툴 정의 로드 차단으로
> 정의 토큰까지 절약) / Add(복원)하는 기능. 툴 단위 deny 토글
> (`2026-07-20-claude-code-tool-deny-toggle-design.md`)의 후속. 대상은 **Claude Code만**.

**날짜:** 2026-07-20
**상태:** 승인됨 (사용자 결정: 지원 범위 = `.mcp.json` + `~/.claude.json` 둘 다,
추가 요구 = 사용 0회인 설정 서버도 트리에 표시)

---

## 1. 목표와 동작

### 1-1. Remove/Add — 서버 소재에 따라 자동 분기

| 서버 소재 | Remove | Add |
|---|---|---|
| 프로젝트 `.mcp.json` | `~/.claude/settings.json`의 `disabledMcpjsonServers` 배열에 서버명 추가 (공식 스위치 — 스펙 파일 이동 없음) | 배열에서 서버명 제거 |
| 유저 전역 `~/.claude.json`의 `mcpServers` (top-level 및 `projects.<path>.mcpServers`) | 해당 항목을 **스태시 파일로 이동** (`~/.mcplens/disabled-servers.json`) | 스태시에서 꺼내 원위치로 복원 |
| 어느 로컬 설정에도 없음 (claude.ai 커넥터 등 — 예: `claude_ai_PlayMCP`) | **메뉴 미노출** — 로컬 파일로 제어 불가 | — |

- 툴 deny와 마찬가지로 적용은 **새 Claude Code 세션부터**. Remove/Add 모두 안내 토스트.
- Remove는 modal 확인 다이얼로그를 거친다 (`vscode.window.showWarningMessage(..., { modal: true }, '차단')`)
  — 스펙 이동은 툴 deny보다 무거운 조작.
- 서버명이 `~/.claude.json`과 `.mcp.json` 양쪽에 있으면 Remove는 **둘 다** 처리한다
  (한쪽만 끄면 여전히 연결됨). Add도 둘 다 복원.

### 1-2. 사용 0회 서버도 트리에 표시 (신규 요구)

트리는 사용 이력(lens.db) 기반이라 지금은 한 번도 안 쓴 서버가 안 보인다.
설정 파일·스태시에서 수집한 claude-code 서버 중 사용 이력에 없는 것을
claude-code 클라이언트 하위에 `0회 · 0tok` 서버 노드로 추가한다:

- 이 노드도 동일하게 우클릭 Remove/Add 가능.
- 꺼진 서버(스태시로 이동돼 설정에는 없는 서버)도 스태시가 수집원이므로 계속 표시 → 복원 가능.
- 툴 자식은 만들지 않는다 (사용 이력이 없으면 툴 목록을 모름 — 정의 스캔 연동은 범위 제외).
- claude-code 클라이언트 노드 자체가 없으면(기간 내 세션 0) `세션 0개` 클라이언트 노드를 만들어 붙인다.

### 1-3. 표시 규칙

- disabled 서버: ✕(`close`) 아이콘 + description 끝 `· 차단됨`.
- disabled 서버의 **하위 툴에는 툴 단위 메뉴를 숨긴다** (contextValue 미부여 — 서버 단위가 우선,
  서버가 꺼져 있으면 툴 deny 토글은 무의미).
- disabled 판정 = `disabledMcpjsonServers`에 있음 **또는** 스태시에 있음. 설정 파일들이
  유일한 원본(source of truth) — 툴 deny 토글과 동일 원칙, 별도 상태 저장소 없음.
  스태시 파일은 상태 저장소가 아니라 "꺼진 서버의 스펙 보관함"이다.

## 2. 범위 제외 (YAGNI)

- codex·gemini-cli 미지원 (메뉴 미노출)
- claude.ai 원격 커넥터 제어 미지원 (로컬 파일에 정의가 없음)
- managed settings(조직 배포) 소스 미지원
- 0회 서버의 툴 목록 표시(정의 스캐너 연동) 미지원
- 비활성 이력 기록 없음 (`disabledAt`은 스태시 항목 메타로만 저장)

## 3. 아키텍처

능력은 core에, extension은 얇은 표면. 서버 소재 판별은 기존 스캐너
(`configSources()`, `collectFromSource()`)를 재사용한다.

### 3-1. core — 공용 헬퍼 추출 + 신규 모듈

**`permissions/fileUtils.ts` (신규, `claudeSettings.ts`에서 추출):**

```ts
/** 읽기: 파일 없으면 null, 파싱 실패 throw. */
export function readJsonFile(filePath: string): unknown | null;
/** 쓰기: .mcplens.bak 백업 + tmp/rename 원자적 쓰기. */
export function writeJsonFile(filePath: string, value: unknown): void;
```

기존 `claudeSettings.ts`의 `readSettings`/`writeSettings`는 이 헬퍼를 사용하도록 정리
(공개 API·동작 불변 — 기존 테스트가 그대로 통과해야 함).

**`permissions/claudeServers.ts` (신규):** 테스트 가능성을 위해 경로 묶음을 인자로 받는다.

```ts
export interface ClaudeConfigPaths {
  settingsPath: string;   // ~/.claude/settings.json
  claudeJsonPath: string; // ~/.claude.json
  stashPath: string;      // ~/.mcplens/disabled-servers.json
  mcpJsonPaths: string[]; // 감지된 프로젝트 .mcp.json 경로들
}
export function defaultClaudeConfigPaths(): ClaudeConfigPaths; // configSources() 재사용

export interface ManagedServer {
  name: string;
  enabled: boolean;                    // false = disabledMcpjsonServers 또는 스태시에 있음
  /** 소재. 'user' = ~/.claude.json (top-level·projects.<path> 모두), 'project' = .mcp.json.
   *  스태시 항목은 스태시에 기록된 origin으로 환산 (user·user-project → 'user'). */
  origins: ('user' | 'project')[];
}
/** 설정 파일들 + 스태시에서 claude-code 서버 전수 수집. 어떤 파일이 깨져도 throw 없이
 *  그 파일만 건너뛴다 (읽기는 관대하게 — parseErrors 원칙). */
export function listManagedServers(paths: ClaudeConfigPaths): ManagedServer[];

/** Remove. 소재를 판별해 분기: user → 스태시로 이동, project → disabledMcpjsonServers 추가.
 *  양쪽에 있으면 둘 다. 쓰기 대상 파일이 깨져 있으면 throw + 미변경 (쓰기는 엄격하게). */
export function disableServer(paths: ClaudeConfigPaths, name: string): void;
/** Add. 역방향: 스태시 항목은 원위치 복원, disabledMcpjsonServers에서 제거. 멱등. */
export function enableServer(paths: ClaudeConfigPaths, name: string): void;
```

스태시 파일 형식 (`~/.mcplens/disabled-servers.json`):

```json
{
  "lenstest": {
    "origin": { "kind": "user" },
    "spec": { "command": "node", "args": ["server.js"] },
    "disabledAt": "2026-07-20T12:00:00Z"
  },
  "other": {
    "origin": { "kind": "user-project", "projectPath": "/Users/x/proj" },
    "spec": { "url": "https://..." },
    "disabledAt": "2026-07-20T12:00:00Z"
  }
}
```

- `origin.kind`: `user`(top-level `mcpServers`) | `user-project`(`projects.<path>.mcpServers`).
  `.mcp.json` 서버는 스태시에 넣지 않는다 (disabledMcpjsonServers 방식이므로).
- `spec`은 `~/.claude.json`에 있던 항목 원형 그대로 (필드 해석 없이 통째 이동 — 복원 무손실).

쓰기 안전장치는 툴 deny와 동일: `.mcplens.bak` 백업, tmp+rename, 파싱 실패 시 미변경.
특히 `~/.claude.json`은 크고 민감한 파일 — 백업이 필수다.

### 3-2. extension 변경

| 파일 | 변경 |
|---|---|
| `src/matrixTree.ts` | `buildTree(input, deniedRules, managedServers?: ManagedServer[])` — ① 서버 노드에 `enabled` 산출(managedServers에서, claude-code만) ② 사용 이력에 없는 managed 서버를 `0회 · 0tok` 노드로 추가 ③ disabled 서버의 하위 툴은 `enabled` 미부여(메뉴 숨김) ④ claude-code 클라이언트 노드가 없으면 생성 |
| `src/lensTreeProvider.ts` | 서버 노드: `n.enabled === false` → ✕ + `contextValue='mcpServer-disabled'`, `true` → `'mcpServer-enabled'`, `undefined`(관리 불가·타 클라이언트) → contextValue 없음 |
| `src/extension.ts` | 커맨드 `mcp-lens.removeServer`(modal 확인 → `disableServer` → 토스트) / `mcp-lens.addServer`(`enableServer` → 토스트). 워처 추가: `~/.claude.json`, 스태시 파일 (settings.json 워처는 기존 것 재사용). refresh 시 `listManagedServers()` 주입 |
| `package.json` | 커맨드 2개, `view/item/context`에 `viewItem == mcpServer-enabled` → removeServer, `mcpServer-disabled` → addServer |

### 3-3. 에러 처리 요약

| 상황 | 동작 |
|---|---|
| 읽기 대상 파일 깨짐 | 그 파일만 건너뛰고 수집 계속 (트리 표시 유지) |
| 쓰기 대상 파일 깨짐 | throw → 에러 토스트 "파일은 변경되지 않음", 미변경 |
| 스태시에 이미 있는 서버 disable | 멱등 no-op |
| 설정 어디에도 없는 서버 enable | 멱등 no-op |
| disable 도중 일부 파일만 성공 (user는 성공, project 쓰기 실패) | 성공분은 유지, 에러 토스트로 부분 실패 명시. 다음 refresh가 실제 상태를 표시하므로 표시 거짓말은 없음 |

## 4. 테스트 전략

- **core 유닛테스트** (`packages/core/test/serverToggle.test.ts`): temp 디렉토리에 픽스처 배치 후
  `listManagedServers`/`disableServer`/`enableServer` 검증. 케이스: user/프로젝트/양쪽 소재 분기,
  스태시 이동·무손실 복원, `projects.<path>.mcpServers` 소재, disabledMcpjsonServers 토글,
  멱등성, 깨진 파일 읽기 관대/쓰기 엄격, 백업 생성, 0회 서버 수집.
- **extension 유닛테스트**: `buildTree`에 managedServers 주입 — 0회 서버 노드 생성,
  disabled 표시, disabled 서버 하위 툴 메뉴 숨김, claude-code 한정, 클라이언트 노드 생성.
- **E2E 스모크 (직렬)**: 실기기에서 유저 전역 서버(lenstest 등) Remove → `~/.claude.json`에서
  항목 이동·스태시 생성 확인 → 새 세션에서 서버 미연결 확인 → Add 복원 → diff로 무손실 확인.

픽스처: `fixtures/claude-settings/`에 추가 — `claude-user.json`(top-level + projects mcpServers),
`mcp-project.json`, `stash-basic.json`.

---

## 5. 터미널 운용 계획 ★ 병렬 실행 분배

### 5-1. 의존성 그래프

```
Wave 0 (직렬 — 메인 터미널, 오케스트레이터 직접)
  Task 0 공유 계약: fileUtils 추출 + claudeServers 스텁·타입 export
                    + buildTree 시그니처(3번째 파라미터) + 픽스처 3종  → main 커밋
        ├──────────────────────────────┐
Wave 1  ▼                              ▼              (2개 완전 병렬)
  [터미널 A] Task 1                [터미널 B] Task 2
  worktree: feat/server-core       worktree: feat/server-ext
  claudeServers 구현 + 테스트       0회 노드·서버 메뉴·워처 + 테스트
  (서브에이전트 sonnet)             (서브에이전트 sonnet)
        └──────────────┬───────────────┘
Wave 2                 ▼               (직렬 — 실기기, 메인 터미널)
  A→B 순서 머지 → Task 3 E2E 스모크
```

### 5-2. 파일 소유권

| 태스크 | 터미널 | Files (목록 밖 수정 금지) |
|---|---|---|
| Task 0 | 메인 (직접) | `packages/core/src/permissions/fileUtils.ts`, `permissions/claudeSettings.ts`(헬퍼 사용으로 정리), `permissions/claudeServers.ts`(스텁), `packages/core/src/index.ts`(export), `packages/extension/src/matrixTree.ts`(시그니처만), `fixtures/claude-settings/claude-user.json·mcp-project.json·stash-basic.json` |
| Task 1 | **터미널 A** | `packages/core/src/permissions/claudeServers.ts`(스텁→구현), `packages/core/test/serverToggle.test.ts` |
| Task 2 | **터미널 B** | `packages/extension/src/matrixTree.ts`(로직), `src/lensTreeProvider.ts`, `src/extension.ts`, `packages/extension/package.json`, `packages/extension/test/matrixTree.test.ts` |
| Task 3 | 메인 (머지 후) | 코드 수정 없음 원칙 |

- 접점(`ManagedServer` 타입, API 시그니처, 스태시 형식, buildTree 3번째 파라미터)은 전부
  Wave 0에서 확정·커밋 — Task 1·2는 파일 무겹침, Task 2는 core 구현을 기다리지 않는다
  (스텁이 빈 배열을 반환해도 컴파일·주입 테스트 가능).
- `fileUtils.ts` 추출을 Wave 0에서 하는 이유: Task 1이 `claudeSettings.ts`를 건드리지 않고도
  공용 헬퍼를 쓸 수 있게 — 툴 deny 코드와의 파일 충돌 원천 차단.

### 5-3. 머지 게이트 (메인 터미널)

- [ ] Wave 0 커밋(기존 permissions 테스트 포함 전체 통과) 후에만 A·B 시작
- [ ] Wave 1 리뷰: 전체 테스트 통과 + Files 준수 + core에 vscode import 없음
- [ ] 머지 순서 `feat/server-core` → `feat/server-ext` (충돌 = 계약 위반 신호)
- [ ] Task 3 E2E 통과 후 worktree 정리

---

## 6. 남은 결정 없음

사용자 결정(지원 범위 둘 다) 및 추가 요구(0회 서버 표시) 반영 완료. 구현 계획 단계 준비됨.
