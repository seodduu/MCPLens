# MCP Lens MVP 구현 계획 — 터미널 병렬 운용 설계 포함

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설계문서 v2의 MVP 4종(비용×사용 매트릭스, 상시 수집+백필, 세션 타임라인, /lens-audit)을 npm workspaces 모노레포(core/extension/cli)로 구현한다.

**Architecture:** 모든 능력은 호스트 독립 라이브러리 `packages/core`(어댑터 3종 + 정의 스캐너 + SQLite 저장소 + 분석 엔진)에 있고, `extension`(VS Code)과 `cli`(npx)는 코어를 호출하는 얇은 표면이다. 병렬 개발의 핵심은 **Wave 0에서 공유 계약(types.ts + DB 스키마 + 픽스처)을 먼저 확정**하는 것 — 이후 어댑터 3종·저장소·스캐너·표면들은 계약에만 의존하므로 서로 완전히 독립이다.

**Tech Stack:** TypeScript(strict), npm workspaces, vitest, sql.js(WASM SQLite), js-tiktoken, @modelcontextprotocol/sdk, chokidar, React(대시보드), Node ≥ 20.

## 전역 제약 (모든 태스크에 적용)

- **core에서 `vscode` 모듈 import 금지.** UI·알림은 extension이 core의 이벤트를 구독해 처리한다.
- **DB는 호스트 무관 공유 경로 `~/.mcplens/lens.db`.** `globalStorageUri` 등 확장 전용 경로 금지.
- **네이티브 애드온 금지.** better-sqlite3 금지 → sql.js(WASM). 토크나이저도 js-tiktoken(순수 JS).
- **경로는 항상 `os.homedir()` + `path.join()`으로 조립.** `~` 문자열 하드코딩 금지 (Windows 대비).
- 원본 로그는 **읽기 전용**. 클라이언트 로그 파일을 절대 수정·이동하지 않는다.
- 파싱 실패는 throw하지 않고 건너뛰며 `parseErrors` 카운트로 보고한다 (비공식 포맷 방어).
- 커밋 메시지는 conventional commits (`feat:`, `test:`, `chore:`).

---

## 0. 터미널 운용 계획 ★ 이 문서의 척추

### 0-1. 의존성 그래프 — 무엇이 독립인가

```
Wave 0 (직렬 — 전부의 전제)
  Task 0 스캐폴드 ─► Task 1 공유 계약 + 픽스처
                          │ (여기서 types.ts / DB 스키마 / 테스트 픽스처가 확정·커밋됨)
        ┌─────────────┬───┴─────────┬──────────────┐
Wave 1  ▼             ▼             ▼              ▼          (4개 완전 독립)
  Claude 어댑터   Codex 어댑터   Gemini 어댑터   저장소+스캐너
  (types+픽스처만) (types+픽스처만) (types+픽스처만) (types만/SDK만)
        └─────────────┴─────┬───────┴──────────────┘
Wave 2                      ▼                                 (2개 독립)
  분석 엔진(엔진은 types만 소비 ← 사실 Wave1과 병렬 가능)
  감지기 + 로그 워처/백필 (어댑터 3종 + 저장소 소비)
        ┌─────────────┬─────┴───────┬──────────────┐
Wave 3  ▼             ▼             ▼              ▼          (4개 완전 독립)
      CLI          VS Code 확장   대시보드      /lens-audit 플러그인
  (core 전체 소비)  (core 전체 소비) (저장소 쿼리 소비) (CLI 출력 소비)
        └─────────────┴─────┬───────┴──────────────┘
Wave 4                      ▼
                    통합 E2E (직렬 — 실기기 로그로 검증)
```

**독립성의 근거 (왜 안전하게 병렬인가):**

| 병렬 단위 | 의존하는 것 | 의존하지 **않는** 것 | 파일 소유권 충돌 |
|---|---|---|---|
| 어댑터 3종 | `types.ts`, 자기 클라이언트 픽스처 | 서로, 저장소, 실기기 상태 | 없음 — 각자 `adapters/<이름>/` 디렉토리 |
| 저장소 | `types.ts` | 어댑터 (이벤트 타입만 알면 됨) | 없음 — `store/` |
| 정의 스캐너 | MCP SDK, js-tiktoken | 어댑터·저장소 전부 | 없음 — `scanner/` |
| 분석 엔진 | `types.ts` (순수 함수) | DB 실물 (인메모리 배열로 테스트) | 없음 — `engine/` |
| CLI / 확장 / 대시보드 / 플러그인 | core 공개 API | 서로 | 없음 — 각자 패키지/디렉토리 |

**직렬이어야만 하는 것 (병렬 금지):**
- Task 0·1 (루트 `package.json`, `tsconfig`, `types.ts`, DB 스키마) — 계약이 흔들리면 전 트랙이 재작업
- Task 9 워처 (어댑터 3종 + 저장소가 실물로 있어야 통합 의미가 있음)
- Task 14 E2E (전부 머지된 뒤)
- **실기기 자원 독점**: 정의 스캐너의 실서버 기동 테스트와 E2E는 같은 MCP 서버 프로세스·같은 DB 파일을 만지므로 동시 실행 금지 — 픽스처/임시 DB(`:memory:` 또는 스크래치 경로)를 쓰는 유닛테스트만 병렬 허용

### 0-2. 실행 모델 — 터미널 × 서브에이전트 하이브리드

두 계층으로 병렬화한다:

```
터미널(=독립 태스크 세트) 계층 : 세트끼리 완전 독립 → 동시 진행 (worktree로 격리)
  └─ 서브에이전트 계층        : 세트 안의 태스크는 순서대로, 태스크마다 fresh 서브에이전트 스폰
                              터미널의 Claude Code 세션은 오케스트레이터 — 스폰·리뷰·커밋 게이트 담당
```

- **터미널 1개 = 독립 세트 1개 = worktree 1개 = 브랜치 1개.** 세트 예: Wave 1의 T4는 {Task 5 → Task 6} 세트 — 저장소가 끝나야 스캐너가 붙으므로 한 터미널에서 직렬, 다른 세트와는 독립.
- **태스크 실행은 서브에이전트가 한다** (superpowers:subagent-driven-development). 오케스트레이터는 태스크 1개 분량의 계획서 내용을 서브에이전트에 넘기고, 완료 보고를 받으면 테스트 통과·소유권 준수를 리뷰한 뒤 다음 태스크의 서브에이전트를 스폰한다.
- 서브에이전트도 소유권 규칙에 묶인다: 자기 태스크의 Files 목록 밖은 수정 금지. 오케스트레이터가 리뷰에서 이를 검사한다.
- **모델 배분은 CLAUDE.md를 따른다**: 오케스트레이터·어댑터(Task 2~4)·E2E(Task 14) = opus, 그 외 태스크 서브에이전트 = sonnet.

### 터미널 배치표

각 터미널 = 독립 세트 1개. **한 터미널(과 그 서브에이전트들)은 자기 소유 디렉토리 밖을 절대 수정하지 않는다.**

| Wave | 터미널 수 | T1 | T2 | T3 | T4 | 완료 신호(싱크 포인트) |
|---|---|---|---|---|---|---|
| 0 | **1** | Task 0 스캐폴드 → Task 1 계약+픽스처 | — | — | — | `main`에 계약 커밋, `npm test` 통과 |
| 1 | **4** | Task 2 Claude 어댑터 | Task 3 Codex 어댑터 | Task 4 Gemini 어댑터 | Task 5 저장소 → Task 6 스캐너 | 4개 브랜치 전부 유닛테스트 통과 → T1이 순서대로 머지 |
| 2 | **2** (+선택 1) | Task 7 분석 엔진 | Task 8 감지기 → Task 9 워처+백필 | (선택: 대시보드 UI 목업 선행) | — | 워처가 픽스처 디렉토리 → DB 적재 E2E 통과 |
| 3 | **4** | Task 10 CLI | Task 11 VS Code 확장 | Task 12 대시보드 | Task 13 /lens-audit 플러그인 | 각 표면이 데모 가능 |
| 4 | **1** | Task 14 통합 E2E + 스모크 | — | — | — | 실기기 로그로 매트릭스 출력 확인 |

권장 총 터미널: **최대 4개**. 5개 이상은 이 프로젝트의 독립 단위 폭을 넘어서 머지 대기만 생긴다.
분석 엔진(Task 7)은 types만 소비하는 순수 함수라 **일손이 남으면 Wave 1의 5번째 트랙으로 앞당겨도 안전**하다.

### 0-3. 터미널별 git 운용 규칙

Wave 0 완료 직후, 각 터미널은 worktree를 만들어 진입한다 (같은 체크아웃에서 4개 세션이 동시 커밋하면 git index 경합이 나므로 worktree가 필수):

```bash
# T1 (Wave 1 예시)
git worktree add ../MCPLens-claude feat/adapter-claude && cd ../MCPLens-claude
# T2
git worktree add ../MCPLens-codex feat/adapter-codex && cd ../MCPLens-codex
# T3
git worktree add ../MCPLens-gemini feat/adapter-gemini && cd ../MCPLens-gemini
# T4
git worktree add ../MCPLens-store feat/store-scanner && cd ../MCPLens-store
```

- 머지는 **항상 T1에서만** 수행: `git merge --no-ff feat/adapter-claude` → codex → gemini → store 순. 파일 소유권이 겹치지 않으므로 충돌은 구조적으로 발생하지 않는다. 충돌이 났다면 누군가 소유권을 어긴 것 — 머지 중단하고 원인 커밋을 되돌린다.
- Wave가 끝나면 worktree 제거: `git worktree remove ../MCPLens-claude` 후 다음 Wave 브랜치를 새로 딴다.
- 루트 파일(`package.json`, `tsconfig.base.json`, `vitest.config.ts`)은 Wave 0 이후 **T1의 머지 커밋에서만** 수정 가능.

### 0-4. 각 터미널에 붙일 지시 프리앰블 (복붙용)

각 터미널의 Claude Code 세션은 **오케스트레이터**로 기동한다. Wave 1의 T4(2태스크 세트) 예시:

> 이 worktree에서 docs/plans/2026-07-19-mcp-lens-mvp-구현계획.md 의 Task 5 → Task 6을 순서대로 수행해.
> superpowers:subagent-driven-development 스킬을 사용해 태스크마다 fresh 서브에이전트를 스폰하고,
> 태스크 사이에 테스트 통과와 파일 소유권 준수를 리뷰한 뒤 다음으로 넘어가.
> 이 세트의 소유 디렉토리는 packages/core/src/store/, packages/core/src/scanner/ 와
> 대응 test/ 디렉토리뿐이며, 그 밖의 파일(특히 types.ts, 루트 설정)은 너도 서브에이전트도
> 절대 수정하지 마. 계약이 안 맞으면 수정하지 말고 보고해.

단일 태스크 세트(예: T2 = Task 3 하나)도 동일 — "Task 3만"으로 바꾸면 된다.

---

## 1. 파일 구조와 소유권

```
MCPLens/
├── package.json                     # [Wave0/T1] workspaces 루트
├── tsconfig.base.json               # [Wave0/T1]
├── vitest.config.ts                 # [Wave0/T1]
├── docs/plans/…                     # 이 문서
├── fixtures/                        # [Wave0/T1] 익명화된 실로그 샘플 — 어댑터 TDD의 재료
│   ├── claude/  session-toolsearch.jsonl, session-upfront.jsonl
│   ├── codex/   rollout-codemode.jsonl
│   └── gemini/  chat-upfront.jsonl
└── packages/
    ├── core/
    │   ├── package.json             # [Wave0/T1]
    │   ├── src/
    │   │   ├── types.ts             # [Wave0/T1] ★ 공유 계약 — 이후 수정은 T1 머지 커밋에서만
    │   │   ├── index.ts             # [Wave0/T1] 공개 API re-export
    │   │   ├── paths.ts             # [Wave0/T1] OS 중립 경로 조립
    │   │   ├── tokenize.ts          # [Wave0/T1] js-tiktoken 래퍼
    │   │   ├── adapters/
    │   │   │   ├── claude/adapter.ts   # [W1/T1]
    │   │   │   ├── codex/adapter.ts    # [W1/T2]
    │   │   │   └── gemini/adapter.ts   # [W1/T3]
    │   │   ├── store/
    │   │   │   ├── schema.sql          # [Wave0/T1] ★ 공유 계약
    │   │   │   └── store.ts            # [W1/T4]
    │   │   ├── scanner/scanner.ts      # [W1/T4]
    │   │   ├── engine/engine.ts        # [W2/T1]
    │   │   ├── detect/detector.ts      # [W2/T2]
    │   │   └── watch/watcher.ts        # [W2/T2]
    │   └── test/                    # src와 미러 구조, 소유권 동일
    ├── cli/                         # [W3/T1]
    │   └── src/main.ts, report.ts
    ├── extension/                   # [W3/T2]
    │   └── src/extension.ts, statusBar.ts
    ├── dashboard/                   # [W3/T3] core 하위가 아닌 별도 workspace (빌드 체인이 달라서)
    │   └── src/…  server.ts(코어 쿼리→JSON) + React 앱
    └── lens-audit-plugin/           # [W3/T4]
        └── .claude-plugin/plugin.json, commands/lens-audit.md
```

---

## 2. Wave 0 — 직렬, 터미널 1개

### Task 0: 모노레포 스캐폴드

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`

**Interfaces:**
- Produces: `npm test` / `npm run build`가 워크스페이스 전체에서 동작하는 뼈대

- [ ] **Step 1: git 초기화와 루트 설정**

```bash
cd /Users/doo._.hyun/Study/Project/MCPLens
git init -b main
```

`package.json`:
```json
{
  "name": "mcp-lens-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
```

`.gitignore`:
```
node_modules/
dist/
*.vsix
.mcplens-scratch/
```

- [ ] **Step 2: core 패키지 뼈대**

`packages/core/package.json`:
```json
{
  "name": "@mcp-lens/core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "sql.js": "^1.11.0",
    "js-tiktoken": "^1.0.14",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "chokidar": "^3.6.0"
  },
  "devDependencies": { "@types/sql.js": "^1.4.9" }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/core/src/index.ts` (일단 빈 export, Task 1에서 채움):
```ts
export {};
```

- [ ] **Step 3: 설치·빌드·테스트가 도는지 확인**

```bash
npm install
npm run build   # 기대: 에러 없이 종료
npm test        # 기대: "no test files found" 또는 0 tests — 에러만 아니면 통과
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold (workspaces, vitest, core skeleton)"
```

### Task 1: 공유 계약(types.ts, schema.sql, paths, tokenize) + 픽스처 추출

이 태스크가 끝나야 Wave 1의 4개 터미널이 출발할 수 있다. **여기서 정의한 이름·타입이 이후 모든 태스크의 어휘다.**

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/paths.ts`, `packages/core/src/tokenize.ts`, `packages/core/src/store/schema.sql`, `packages/core/src/index.ts`(갱신)
- Create: `fixtures/claude/*.jsonl`, `fixtures/codex/*.jsonl`, `fixtures/gemini/*.jsonl`
- Test: `packages/core/test/tokenize.test.ts`, `packages/core/test/paths.test.ts`

**Interfaces:**
- Produces: 아래 types.ts 전문 — **모든 후속 태스크의 Consumes 대상**

- [ ] **Step 1: types.ts 작성 (전문 — 이대로 커밋)**

```ts
// packages/core/src/types.ts
export type ClientId = 'claude-code' | 'codex' | 'gemini-cli';

/** 설계문서 4-3의 회계 모드 4종 */
export type AccountingMode =
  | 'UPFRONT'
  | 'DEFERRED_MEASURABLE'
  | 'DEFERRED_ESTIMATED'
  | 'DEFERRED_OPAQUE';

export interface SessionMeta {
  /** 파일 절대경로의 sha256 앞 16자리 — 재파싱해도 동일해야 함 */
  sessionId: string;
  client: ClientId;
  filePath: string;
  startedAt: string | null; // ISO 8601
  mode: AccountingMode;
}

export interface ToolCallEvent {
  sessionId: string;
  serverName: string; // MCP 서버 이름 (예: 'github')
  toolName: string;   // 서버 접두어 제거된 툴 이름
  calledAt: string | null;
  durationMs: number | null;
  isError: boolean;
  /** 클라이언트가 기록한 실측 응답 토큰. 없으면 responseText를 tiktoken */
  responseTokens: number | null;
  responseText: string | null;
}

/** 지연 로딩 세션에서 "이 정의가 컨텍스트에 로드됐다"는 증거 */
export interface ToolLoadEvent {
  sessionId: string;
  serverName: string | null; // Claude는 이름만 기록 → 스캐너와 조인 전엔 null 가능
  toolName: string;
  /** Codex처럼 로드 원문이 기록되면 직접 토크나이즈한 값, 아니면 null(조인으로 산출) */
  loadedTokens: number | null;
}

export interface TokenUsageEvent {
  sessionId: string;
  at: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** 어댑터 1회 파싱의 산출물 — 워처·백필이 이것을 저장소에 적재 */
export interface AdapterResult {
  session: SessionMeta;
  toolCalls: ToolCallEvent[];
  toolLoads: ToolLoadEvent[];
  usage: TokenUsageEvent[];
  parseErrors: number;
}

export interface LogAdapter {
  readonly client: ClientId;
  /** 감시 대상 루트 디렉토리들 (절대경로, 존재하지 않을 수 있음) */
  sessionRoots(): string[];
  /** 이 파일이 내 세션 파일인가 */
  matches(filePath: string): boolean;
  /** content 전체를 파싱. 증분 파싱은 워처가 content를 잘라서 넘기는 방식으로 처리 */
  parseFile(filePath: string, content: string): AdapterResult;
}

/** 정의 스캐너 산출물 (비용 축) */
export interface ToolDefinition {
  serverName: string;
  toolName: string;
  definitionTokens: number;
  scannedAt: string;
}

/** 분석 엔진 산출물 — 매트릭스 1행 = 툴 1개 */
export interface MatrixRow {
  serverName: string;
  toolName: string;
  definitionTokens: number | null; // 스캐너 미커버 시 null
  callCount: number;
  responseTokens: number;
  loadedSessionCount: number; // DEFERRED에서 정의가 로드된 세션 수
  sessionCount: number;       // 이 서버가 연결돼 있던 세션 수(근사: 전체 세션 수)
  recommendation: Recommendation;
}

export interface Recommendation {
  action: 'remove' | 'filter-server' | 'keep' | 'unknown';
  /** 모드 인지 표기: 업프론트면 "매 세션 N토큰 절약", 지연이면 "검색 공간 정리" */
  reason: string;
  evidenceLabel: '실측' | '하한 추정' | '전량 가정' | '측정 불가';
}
```

- [ ] **Step 2: paths.ts + 실패하는 테스트 → 구현**

`packages/core/test/paths.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { lensHome, dbPath, clientLogRoots } from '../src/paths.js';
import os from 'node:os';
import path from 'node:path';

describe('paths', () => {
  it('lensHome은 홈 밑 .mcplens', () => {
    expect(lensHome()).toBe(path.join(os.homedir(), '.mcplens'));
  });
  it('dbPath는 lens.db', () => {
    expect(dbPath()).toBe(path.join(os.homedir(), '.mcplens', 'lens.db'));
  });
  it('클라이언트 로그 루트는 ~ 하드코딩 없이 절대경로', () => {
    const roots = clientLogRoots('claude-code');
    expect(roots[0]).toBe(path.join(os.homedir(), '.claude', 'projects'));
    expect(roots.every((r) => path.isAbsolute(r))).toBe(true);
  });
});
```

`packages/core/src/paths.ts`:
```ts
import os from 'node:os';
import path from 'node:path';
import type { ClientId } from './types.js';

export function lensHome(): string {
  return path.join(os.homedir(), '.mcplens');
}
export function dbPath(): string {
  return path.join(lensHome(), 'lens.db');
}
export function clientLogRoots(client: ClientId): string[] {
  const h = os.homedir();
  switch (client) {
    case 'claude-code': return [path.join(h, '.claude', 'projects')];
    case 'codex':       return [path.join(h, '.codex', 'sessions')];
    case 'gemini-cli':  return [path.join(h, '.gemini', 'tmp')];
  }
}
```

- [ ] **Step 3: tokenize.ts + 테스트**

`packages/core/test/tokenize.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { countTokens } from '../src/tokenize.js';

describe('countTokens', () => {
  it('빈 문자열은 0', () => expect(countTokens('')).toBe(0));
  it('영문 문장은 양의 정수', () => {
    const n = countTokens('list repository issues by label');
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});
```

`packages/core/src/tokenize.ts`:
```ts
import { getEncoding, type Tiktoken } from 'js-tiktoken';

let enc: Tiktoken | null = null;
export function countTokens(text: string): number {
  if (text === '') return 0;
  if (!enc) enc = getEncoding('o200k_base');
  return enc.encode(text).length;
}
```

- [ ] **Step 4: schema.sql 작성 (전문 — 저장소(T4)와 엔진(W2/T1)이 공유하는 계약)**

`packages/core/src/store/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  client      TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  started_at  TEXT,
  mode        TEXT NOT NULL DEFAULT 'DEFERRED_OPAQUE'
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  server_name     TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  called_at       TEXT,
  duration_ms     INTEGER,
  is_error        INTEGER NOT NULL DEFAULT 0,
  response_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS tool_loads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  server_name TEXT,
  tool_name   TEXT NOT NULL,
  loaded_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS tool_definitions (
  server_name       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  definition_tokens INTEGER NOT NULL,
  scanned_at        TEXT NOT NULL,
  PRIMARY KEY (server_name, tool_name)
);
CREATE TABLE IF NOT EXISTS token_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  at            TEXT,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);
-- 증분 파싱 커서: 파일별로 어디까지 읽었나 (바이트 오프셋)
CREATE TABLE IF NOT EXISTS file_cursors (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_calls_tool ON tool_calls(server_name, tool_name);
CREATE INDEX IF NOT EXISTS idx_loads_session ON tool_loads(session_id);
```

- [ ] **Step 5: index.ts 공개 API 갱신**

```ts
// packages/core/src/index.ts
export * from './types.js';
export * from './paths.js';
export { countTokens } from './tokenize.js';
```

- [ ] **Step 6: 픽스처 추출 — 자기 머신의 실로그에서 샘플 복사 + 익명화**

이 단계가 Wave 1 병렬화의 물적 조건이다. 어댑터 트랙들이 실기기 상태와 독립되려면 커밋된 픽스처가 필요하다.

```bash
mkdir -p fixtures/claude fixtures/codex fixtures/gemini
# 각 디렉토리에서 MCP 툴콜이 포함된 작은 세션 파일을 고른다 (grep으로 후보 탐색)
grep -l '"mcp__' ~/.claude/projects/*/*.jsonl | head -3
grep -l 'mcp_tool_call_end' ~/.codex/sessions/*/*.jsonl | head -3
grep -rl 'functionCall' ~/.gemini/tmp/*/chats/ | head -3
# 고른 파일을 fixtures/<client>/ 로 복사한 뒤, 에디터에서 개인 식별 정보
# (프로젝트 경로, 사용자명, API 응답 속 사적 내용)를 치환한다. 구조·필드명은 보존.
```

체크리스트: Claude 픽스처에는 `tool_use`/`tool_result` 쌍 + `usage` + (가능하면) `tool_reference`가, Codex 픽스처에는 `mcp_tool_call_end` + `token_count` + ALL_TOOLS 검색 스크립트가, Gemini 픽스처에는 `functionCall`/`functionResponse` + 레코드별 토큰 분해가 실제로 들어 있어야 한다. **없으면 해당 어댑터 태스크가 검증 불능이므로 여기서 반드시 확보.**

- [ ] **Step 7: 전체 테스트 통과 확인 후 커밋 — Wave 0 싱크 포인트**

```bash
npm test    # 기대: paths, tokenize 테스트 전부 PASS
git add -A && git commit -m "feat: shared contracts (types, schema, paths, tokenize) + fixtures"
```

**→ 여기서부터 터미널 4개로 분기한다 (0-3의 worktree 명령 실행).**

---

## 3. Wave 1 — 터미널 4개 완전 병렬

### Task 2: Claude Code 어댑터 [T1 · feat/adapter-claude]

**Files:**
- Create: `packages/core/src/adapters/claude/adapter.ts`
- Test: `packages/core/test/adapters/claude/adapter.test.ts`
- 소유권 밖 수정 금지: `types.ts`, 루트 설정

**Interfaces:**
- Consumes: `LogAdapter`, `AdapterResult` 등 types.ts 전부, `clientLogRoots('claude-code')`, `countTokens`
- Produces: `export class ClaudeAdapter implements LogAdapter` — 워처(Task 9)가 `new ClaudeAdapter()`로 사용

**파싱 명세 (설계문서 5장 실증 기반):**
- 파일: JSONL, 한 줄 = 한 레코드. `message.content[]` 안에 `{type:'tool_use', id, name, input}` / `{type:'tool_result', tool_use_id, content}`.
- MCP 툴 판별: `name`이 `/^mcp__(.+?)__(.+)$/` — 그룹1=서버, 그룹2=툴. 매칭 안 되면 내장 툴 → 무시.
- 토큰: `message.usage` = `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`.
- 모드 판별: `tool_reference` 필드(Tool Search 로드 기록) 또는 ToolSearch 이벤트가 1건이라도 있으면 `DEFERRED_MEASURABLE`, MCP 툴콜이 있는데 로드 신호가 없으면 `UPFRONT`. 로드 이벤트는 `ToolLoadEvent{toolName, loadedTokens: null}` — **토큰은 기록되지 않으므로 null로 두고 엔진이 스캐너와 조인**한다.
- `tool_result`의 응답 본문: 문자열이면 그대로, 배열이면 `content[].text`를 이어붙여 `responseText`에 저장 (`responseTokens`는 null — Claude는 툴 응답만 분리 실측하지 않음).
- 방어: JSON.parse 실패 줄은 `parseErrors++` 후 skip. 필드 없으면 skip.

- [ ] **Step 1: 픽스처를 읽는 실패하는 테스트 작성**

```ts
// packages/core/test/adapters/claude/adapter.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter.js';

const fx = (f: string) =>
  readFileSync(path.join(__dirname, '../../../../../fixtures/claude', f), 'utf8');

describe('ClaudeAdapter', () => {
  const a = new ClaudeAdapter();

  it('matches는 .claude/projects 밑 jsonl만 승인', () => {
    expect(a.matches('/home/u/.claude/projects/-x-y/abc.jsonl')).toBe(true);
    expect(a.matches('/home/u/.codex/sessions/2026/r.jsonl')).toBe(false);
  });

  it('tool_use/tool_result 쌍을 ToolCallEvent로 뽑고 서버/툴 이름을 분해한다', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.toolCalls.length).toBeGreaterThan(0);
    const c = r.toolCalls[0];
    expect(c.serverName).not.toContain('mcp__');
    expect(c.toolName).not.toContain('__');
    expect(c.responseText === null || typeof c.responseText === 'string').toBe(true);
  });

  it('tool_reference가 있으면 DEFERRED_MEASURABLE + toolLoads 산출', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.session.mode).toBe('DEFERRED_MEASURABLE');
    expect(r.toolLoads.length).toBeGreaterThan(0);
    expect(r.toolLoads[0].loadedTokens).toBeNull(); // 조인 전엔 이름만
  });

  it('usage를 TokenUsageEvent로 적재한다', () => {
    const r = a.parseFile('/fake/s.jsonl', fx('session-toolsearch.jsonl'));
    expect(r.usage.length).toBeGreaterThan(0);
    expect(r.usage[0].inputTokens).toBeGreaterThanOrEqual(0);
  });

  it('깨진 줄은 throw 없이 parseErrors로 계수', () => {
    const r = a.parseFile('/fake/s.jsonl', 'not-json\n' + fx('session-upfront.jsonl'));
    expect(r.parseErrors).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run packages/core/test/adapters/claude -c vitest.config.ts` → 기대: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```ts
// packages/core/src/adapters/claude/adapter.ts
import crypto from 'node:crypto';
import path from 'node:path';
import type { AdapterResult, LogAdapter, SessionMeta, ToolCallEvent,
  ToolLoadEvent, TokenUsageEvent } from '../../types.js';
import { clientLogRoots } from '../../paths.js';

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export class ClaudeAdapter implements LogAdapter {
  readonly client = 'claude-code' as const;

  sessionRoots(): string[] { return clientLogRoots('claude-code'); }

  matches(filePath: string): boolean {
    const p = filePath.split(path.sep).join('/');
    return /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(p);
  }

  parseFile(filePath: string, content: string): AdapterResult {
    const sessionId = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const toolCalls: ToolCallEvent[] = [];
    const toolLoads: ToolLoadEvent[] = [];
    const usage: TokenUsageEvent[] = [];
    const pendingUse = new Map<string, { server: string; tool: string; at: string | null }>();
    let parseErrors = 0;
    let startedAt: string | null = null;
    let sawLoadSignal = false;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
      startedAt ??= rec.timestamp ?? null;

      // Tool Search 로드 신호: tool_reference 목록 (형태는 픽스처로 확정)
      const refs: string[] | undefined = rec.toolUseResult?.tool_references ?? rec.tool_reference;
      if (Array.isArray(refs)) {
        sawLoadSignal = true;
        for (const name of refs) {
          const m = MCP_NAME.exec(String(name));
          toolLoads.push({
            sessionId,
            serverName: m ? m[1] : null,
            toolName: m ? m[2] : String(name),
            loadedTokens: null,
          });
        }
      }

      const msg = rec.message;
      if (!msg) continue;
      if (msg.usage) {
        usage.push({
          sessionId, at: rec.timestamp ?? null,
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
        });
      }
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        if (part.type === 'tool_use') {
          const m = MCP_NAME.exec(part.name ?? '');
          if (m) pendingUse.set(part.id, { server: m[1], tool: m[2], at: rec.timestamp ?? null });
        } else if (part.type === 'tool_result' && pendingUse.has(part.tool_use_id)) {
          const u = pendingUse.get(part.tool_use_id)!;
          pendingUse.delete(part.tool_use_id);
          toolCalls.push({
            sessionId, serverName: u.server, toolName: u.tool, calledAt: u.at,
            durationMs: null, isError: part.is_error === true,
            responseTokens: null, responseText: flattenResult(part.content),
          });
        }
      }
    }

    const hasMcp = toolCalls.length > 0 || toolLoads.length > 0;
    const session: SessionMeta = {
      sessionId, client: this.client, filePath, startedAt,
      mode: sawLoadSignal ? 'DEFERRED_MEASURABLE' : hasMcp ? 'UPFRONT' : 'DEFERRED_OPAQUE',
    };
    return { session, toolCalls, toolLoads, usage, parseErrors };
  }
}

function flattenResult(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
  return null;
}
```

**주의:** `tool_reference`의 정확한 위치·이름은 픽스처에서 확인해 위 두 후보(`toolUseResult.tool_references` / `tool_reference`) 중 실제 것으로 좁혀라. 픽스처와 다르면 **어댑터 쪽을 픽스처에 맞춘다** (계약 types.ts는 불변).

- [ ] **Step 4: 통과 확인** — 같은 명령 재실행 → 기대: PASS 5/5

- [ ] **Step 5: Commit** — `git add packages/core/src/adapters/claude packages/core/test/adapters/claude && git commit -m "feat: claude code log adapter"`

### Task 3: Codex 어댑터 [T2 · feat/adapter-codex]

**Files:**
- Create: `packages/core/src/adapters/codex/adapter.ts`
- Test: `packages/core/test/adapters/codex/adapter.test.ts`

**Interfaces:**
- Consumes: types.ts 전부, `clientLogRoots('codex')`, `countTokens`
- Produces: `export class CodexAdapter implements LogAdapter`

**파싱 명세:**
- 파일: `~/.codex/sessions/<날짜>/rollout-*.jsonl`.
- 툴콜: `type === 'mcp_tool_call_end'` 레코드 — `payload.invocation.{server, tool, arguments}`, `payload.duration`(또는 duration_ms — 픽스처로 확정), 결과 성공/실패.
- 토큰: `type === 'token_count'` — 누적+턴별 동시 제공이므로 **턴별 값을 채택** (누적을 쓰면 이중계상).
- 모드 판별: `custom_tool_call` 중 ALL_TOOLS 검색 스크립트(코드 모드) 레코드가 있으면 `DEFERRED_MEASURABLE`. 그 레코드의 **출력 원문이 로드된 정의**이므로 `countTokens(출력 원문)`로 `ToolLoadEvent.loadedTokens`를 직접 채운다 (Claude와 달리 조인 불필요 — 설계문서 5장의 클라이언트별 차이).
- 툴 이름: invocation에 server/tool이 구조화되어 있으므로 정규식 분해 불필요.
- token_count가 없는 구세션(2025-09 이전)은 usage 빈 배열로 정상 처리.

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/core/test/adapters/codex/adapter.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CodexAdapter } from '../../../src/adapters/codex/adapter.js';

const fx = readFileSync(
  path.join(__dirname, '../../../../../fixtures/codex/rollout-codemode.jsonl'), 'utf8');

describe('CodexAdapter', () => {
  const a = new CodexAdapter();

  it('matches는 .codex/sessions 밑 rollout-*.jsonl만 승인', () => {
    expect(a.matches('/h/.codex/sessions/2026-07-19/rollout-1.jsonl')).toBe(true);
    expect(a.matches('/h/.claude/projects/x/y.jsonl')).toBe(false);
  });

  it('mcp_tool_call_end에서 server/tool/duration을 구조화 필드로 뽑는다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.toolCalls[0].serverName).toBeTruthy();
    expect(r.toolCalls[0].durationMs === null ||
           r.toolCalls[0].durationMs! >= 0).toBe(true);
  });

  it('코드 모드 검색 스크립트가 있으면 DEFERRED_MEASURABLE이고 loadedTokens가 직접 계산된다', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.session.mode).toBe('DEFERRED_MEASURABLE');
    const withTokens = r.toolLoads.filter((l) => (l.loadedTokens ?? 0) > 0);
    expect(withTokens.length).toBeGreaterThan(0); // Codex는 원문 기록 → 직접 토크나이즈
  });

  it('token_count는 턴별 값으로 usage 적재 (누적 아님)', () => {
    const r = a.parseFile('/fake/r.jsonl', fx);
    expect(r.usage.length).toBeGreaterThan(0);
  });

  it('깨진 줄은 parseErrors', () => {
    const r = a.parseFile('/fake/r.jsonl', '{broken\n' + fx);
    expect(r.parseErrors).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run packages/core/test/adapters/codex` → FAIL

- [ ] **Step 3: 구현**

```ts
// packages/core/src/adapters/codex/adapter.ts
import crypto from 'node:crypto';
import path from 'node:path';
import type { AdapterResult, LogAdapter, SessionMeta, ToolCallEvent,
  ToolLoadEvent, TokenUsageEvent } from '../../types.js';
import { clientLogRoots } from '../../paths.js';
import { countTokens } from '../../tokenize.js';

export class CodexAdapter implements LogAdapter {
  readonly client = 'codex' as const;

  sessionRoots(): string[] { return clientLogRoots('codex'); }

  matches(filePath: string): boolean {
    const p = filePath.split(path.sep).join('/');
    return /\/\.codex\/sessions\/[^/]+\/rollout-[^/]+\.jsonl$/.test(p);
  }

  parseFile(filePath: string, content: string): AdapterResult {
    const sessionId = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const toolCalls: ToolCallEvent[] = [];
    const toolLoads: ToolLoadEvent[] = [];
    const usage: TokenUsageEvent[] = [];
    let parseErrors = 0;
    let startedAt: string | null = null;
    let sawCodeModeSearch = false;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
      startedAt ??= rec.timestamp ?? null;
      const t = rec.type ?? rec.payload?.type;

      if (t === 'mcp_tool_call_end') {
        const inv = rec.payload?.invocation ?? rec.invocation ?? {};
        toolCalls.push({
          sessionId,
          serverName: String(inv.server ?? 'unknown'),
          toolName: String(inv.tool ?? 'unknown'),
          calledAt: rec.timestamp ?? null,
          durationMs: numOrNull(rec.payload?.duration_ms ?? rec.payload?.duration),
          isError: rec.payload?.result?.isError === true,
          responseTokens: null,
          responseText: stringifyOrNull(rec.payload?.result),
        });
      } else if (t === 'custom_tool_call') {
        const text = JSON.stringify(rec.payload ?? rec);
        if (text.includes('ALL_TOOLS')) {
          sawCodeModeSearch = true;
          // 검색 스크립트의 출력 원문 = 로드된 정의 → 직접 토크나이즈
          const output = rec.payload?.output ?? rec.payload?.result ?? '';
          const outText = typeof output === 'string' ? output : JSON.stringify(output);
          if (outText) {
            toolLoads.push({
              sessionId, serverName: null,
              toolName: '(code-mode-search)',
              loadedTokens: countTokens(outText),
            });
          }
        }
      } else if (t === 'token_count') {
        const turn = rec.payload?.last_token_usage ?? rec.payload?.info?.last_token_usage;
        if (turn) {
          usage.push({
            sessionId, at: rec.timestamp ?? null,
            inputTokens: turn.input_tokens ?? 0,
            outputTokens: turn.output_tokens ?? 0,
            cacheReadTokens: turn.cached_input_tokens ?? 0,
            cacheCreationTokens: 0,
          });
        }
      }
    }

    const session: SessionMeta = {
      sessionId, client: this.client, filePath, startedAt,
      mode: sawCodeModeSearch ? 'DEFERRED_MEASURABLE'
          : toolCalls.length > 0 ? 'UPFRONT' : 'DEFERRED_OPAQUE',
    };
    return { session, toolCalls, toolLoads, usage, parseErrors };
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function stringifyOrNull(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
```

**주의:** `token_count` 턴별 필드의 실제 이름(`last_token_usage` 등)과 `custom_tool_call` 출력 위치는 픽스처에서 확정하고 코드를 픽스처에 맞춰라.

- [ ] **Step 4: 통과 확인** → PASS 5/5
- [ ] **Step 5: Commit** — `git commit -m "feat: codex rollout adapter"`

### Task 4: Gemini CLI 어댑터 [T3 · feat/adapter-gemini]

**Files:**
- Create: `packages/core/src/adapters/gemini/adapter.ts`
- Test: `packages/core/test/adapters/gemini/adapter.test.ts`

**Interfaces:**
- Consumes: types.ts, `clientLogRoots('gemini-cli')`, `countTokens`
- Produces: `export class GeminiAdapter implements LogAdapter`

**파싱 명세:**
- 파일: `~/.gemini/tmp/<workdir-hash>/chats/*.jsonl` (하위 어디든 `chats/` 밑 json/jsonl — 픽스처로 확정).
- 툴콜: 레코드의 `parts[]`에 `{functionCall:{name, args}}` / `{functionResponse:{name, response}}`.
- **이름 분해 주의**: `mcp_<서버>_<툴>` flatten이라 서버명에 `_`가 있으면 분해가 모호하다. MVP 규칙: `/^mcp_(.+)$/` 벗긴 뒤 **첫 `_`에서 분리**하고, 저장 시 `serverName`에 모호 가능성이 있음을 감수한다(엔진 조인 시 스캐너의 실제 서버 이름 목록과 대조해 보정하는 로직은 Task 7 소유). `mcp_` 접두어가 없으면 내장 툴 → 무시.
- 모드: 지연 신호가 원리적으로 없음 → MCP 툴콜이 있으면 무조건 `UPFRONT`, 없으면 `DEFERRED_OPAQUE`. `toolLoads`는 항상 빈 배열.
- 응답 토큰: 레코드별 토큰 분해에 `tool` 필드가 있으면 그 실측값을 `responseTokens`로 사용. 없으면 `functionResponse` 본문을 `responseText`로. **`<untrusted_context>` 래퍼 텍스트도 응답 본문에 포함시켜 계상** (설계문서 5장 특이사항).

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/core/test/adapters/gemini/adapter.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GeminiAdapter, splitFlattenedName } from '../../../src/adapters/gemini/adapter.js';

const fx = readFileSync(
  path.join(__dirname, '../../../../../fixtures/gemini/chat-upfront.jsonl'), 'utf8');

describe('splitFlattenedName', () => {
  it('mcp_ 접두어를 벗기고 첫 _에서 서버/툴 분리', () => {
    expect(splitFlattenedName('mcp_github_list_issues'))
      .toEqual({ server: 'github', tool: 'list_issues' });
  });
  it('mcp_ 접두어 없으면 null (내장 툴)', () => {
    expect(splitFlattenedName('read_file')).toBeNull();
  });
});

describe('GeminiAdapter', () => {
  const a = new GeminiAdapter();

  it('matches는 .gemini/tmp 밑 chats 파일만 승인', () => {
    expect(a.matches('/h/.gemini/tmp/abc/chats/s1.jsonl')).toBe(true);
    expect(a.matches('/h/.codex/sessions/d/rollout-1.jsonl')).toBe(false);
  });

  it('functionCall/functionResponse에서 ToolCallEvent를 뽑는다', () => {
    const r = a.parseFile('/fake/c.jsonl', fx);
    expect(r.toolCalls.length).toBeGreaterThan(0);
  });

  it('모드는 항상 UPFRONT(MCP 콜 존재 시)이고 toolLoads는 빈 배열', () => {
    const r = a.parseFile('/fake/c.jsonl', fx);
    expect(r.session.mode).toBe('UPFRONT');
    expect(r.toolLoads).toEqual([]);
  });

  it('untrusted_context 래퍼도 responseText에 포함된다', () => {
    const r = a.parseFile('/fake/c.jsonl', fx);
    const withBody = r.toolCalls.find((c) => c.responseText);
    // 픽스처에 래퍼가 있으므로 본문 어딘가에 포함되어야 함
    expect(withBody?.responseText).toContain('untrusted_context');
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: 구현**

```ts
// packages/core/src/adapters/gemini/adapter.ts
import crypto from 'node:crypto';
import path from 'node:path';
import type { AdapterResult, LogAdapter, SessionMeta, ToolCallEvent,
  TokenUsageEvent } from '../../types.js';
import { clientLogRoots } from '../../paths.js';

export function splitFlattenedName(name: string): { server: string; tool: string } | null {
  const m = /^mcp_(.+)$/.exec(name);
  if (!m) return null;
  const i = m[1].indexOf('_');
  if (i < 0) return { server: m[1], tool: m[1] };
  return { server: m[1].slice(0, i), tool: m[1].slice(i + 1) };
}

export class GeminiAdapter implements LogAdapter {
  readonly client = 'gemini-cli' as const;

  sessionRoots(): string[] { return clientLogRoots('gemini-cli'); }

  matches(filePath: string): boolean {
    const p = filePath.split(path.sep).join('/');
    return /\/\.gemini\/tmp\/.+\/chats\/[^/]+\.jsonl?$/.test(p);
  }

  parseFile(filePath: string, content: string): AdapterResult {
    const sessionId = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const toolCalls: ToolCallEvent[] = [];
    const usage: TokenUsageEvent[] = [];
    let parseErrors = 0;
    let startedAt: string | null = null;
    // functionResponse는 이름으로 매칭 (Gemini는 use_id 개념이 없음)
    const pending = new Map<string, { server: string; tool: string; at: string | null }>();

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
      startedAt ??= rec.timestamp ?? null;

      const tokens = rec.tokens ?? rec.usageMetadata;
      if (tokens) {
        usage.push({
          sessionId, at: rec.timestamp ?? null,
          inputTokens: tokens.input ?? tokens.promptTokenCount ?? 0,
          outputTokens: tokens.output ?? tokens.candidatesTokenCount ?? 0,
          cacheReadTokens: tokens.cached ?? 0,
          cacheCreationTokens: 0,
        });
      }

      const parts: any[] = rec.parts ?? rec.content?.parts ?? [];
      for (const part of parts) {
        if (part.functionCall) {
          const s = splitFlattenedName(String(part.functionCall.name ?? ''));
          if (s) pending.set(part.functionCall.name, { ...s, at: rec.timestamp ?? null });
        } else if (part.functionResponse) {
          const key = String(part.functionResponse.name ?? '');
          const p = pending.get(key);
          if (!p) continue;
          pending.delete(key);
          const body = part.functionResponse.response;
          toolCalls.push({
            sessionId, serverName: p.server, toolName: p.tool, calledAt: p.at,
            durationMs: null, isError: false,
            responseTokens: numOrNull(rec.tokens?.tool),
            responseText: typeof body === 'string' ? body : JSON.stringify(body ?? null),
          });
        }
      }
    }

    const session: SessionMeta = {
      sessionId, client: this.client, filePath, startedAt,
      mode: toolCalls.length > 0 ? 'UPFRONT' : 'DEFERRED_OPAQUE',
    };
    return { session, toolCalls, toolLoads: [], usage, parseErrors };
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
```

- [ ] **Step 4: 통과 확인** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: gemini cli chat adapter"`

### Task 5: SQLite 저장소 [T4 · feat/store-scanner]

**Files:**
- Create: `packages/core/src/store/store.ts`
- Test: `packages/core/test/store/store.test.ts`

**Interfaces:**
- Consumes: `schema.sql`, types.ts의 `AdapterResult`, `ToolDefinition`
- Produces (Task 7·9·10·12가 소비하는 계약):
  ```ts
  export class LensStore {
    static async open(filePath: string | ':memory:'): Promise<LensStore>;
    ingest(result: AdapterResult): void;              // 세션 upsert + 이벤트 재적재(세션 단위 delete→insert로 멱등)
    upsertDefinitions(defs: ToolDefinition[]): void;
    getCursor(filePath: string): { byteOffset: number; mtimeMs: number } | null;
    setCursor(filePath: string, byteOffset: number, mtimeMs: number): void;
    // 엔진·표면용 원시 조회
    allDefinitions(): ToolDefinition[];
    callsSince(isoDate: string): ToolCallEvent[];
    loadsSince(isoDate: string): ToolLoadEvent[];
    sessionsSince(isoDate: string): SessionMeta[];
    save(): void;                                     // sql.js는 수동 영속화 — 디스크에 flush
    close(): void;
  }
  ```

**핵심 설계:** sql.js는 인메모리 DB라 **`save()`가 명시적으로 파일에 쓴다**. `ingest()`는 같은 세션 재파싱 시 이중계상이 없도록 `DELETE FROM tool_calls WHERE session_id = ?` 후 insert (멱등). `save()`는 원자적이어야 함: 임시파일에 쓰고 rename.

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/core/test/store/store.test.ts
import { describe, it, expect } from 'vitest';
import { LensStore } from '../../src/store/store.js';
import type { AdapterResult } from '../../src/types.js';

function fakeResult(sessionId: string, calls = 2): AdapterResult {
  return {
    session: { sessionId, client: 'claude-code', filePath: `/f/${sessionId}.jsonl`,
      startedAt: '2026-07-01T00:00:00Z', mode: 'DEFERRED_MEASURABLE' },
    toolCalls: Array.from({ length: calls }, (_, i) => ({
      sessionId, serverName: 'github', toolName: `tool${i}`,
      calledAt: '2026-07-01T00:01:00Z', durationMs: 100, isError: false,
      responseTokens: 50, responseText: null })),
    toolLoads: [{ sessionId, serverName: 'github', toolName: 'tool0', loadedTokens: null }],
    usage: [{ sessionId, at: '2026-07-01T00:01:00Z', inputTokens: 1000,
      outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    parseErrors: 0,
  };
}

describe('LensStore', () => {
  it('ingest 후 조회된다', async () => {
    const s = await LensStore.open(':memory:');
    s.ingest(fakeResult('s1'));
    expect(s.callsSince('2026-01-01')).toHaveLength(2);
    expect(s.sessionsSince('2026-01-01')).toHaveLength(1);
  });

  it('같은 세션 재적재는 멱등 (이중계상 없음)', async () => {
    const s = await LensStore.open(':memory:');
    s.ingest(fakeResult('s1'));
    s.ingest(fakeResult('s1', 3)); // 재파싱: 3콜로 갱신
    expect(s.callsSince('2026-01-01')).toHaveLength(3); // 2+3=5가 아니라 3
  });

  it('커서 get/set 왕복', async () => {
    const s = await LensStore.open(':memory:');
    expect(s.getCursor('/a')).toBeNull();
    s.setCursor('/a', 1024, 999);
    expect(s.getCursor('/a')).toEqual({ byteOffset: 1024, mtimeMs: 999 });
  });

  it('save는 파일로 영속화되고 재open 시 데이터가 남는다', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lens-test-${Date.now()}.db`;
    const s = await LensStore.open(tmp);
    s.ingest(fakeResult('s1'));
    s.save(); s.close();
    const s2 = await LensStore.open(tmp);
    expect(s2.callsSince('2026-01-01')).toHaveLength(2);
    s2.close();
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: 구현**

```ts
// packages/core/src/store/store.ts
import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterResult, SessionMeta, ToolCallEvent, ToolDefinition,
  ToolLoadEvent } from '../types.js';

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

export class LensStore {
  private constructor(private db: Database, private filePath: string) {}

  static async open(filePath: string): Promise<LensStore> {
    const SQL = await initSqlJs();
    const db = filePath !== ':memory:' && existsSync(filePath)
      ? new SQL.Database(readFileSync(filePath))
      : new SQL.Database();
    db.exec(SCHEMA);
    return new LensStore(db, filePath);
  }

  ingest(r: AdapterResult): void {
    const { session: s } = r;
    this.db.exec('BEGIN');
    try {
      this.run(
        `INSERT INTO sessions(session_id, client, file_path, started_at, mode)
         VALUES(?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, started_at=excluded.started_at`,
        [s.sessionId, s.client, s.filePath, s.startedAt, s.mode]);
      for (const t of ['tool_calls', 'tool_loads', 'token_usage'])
        this.run(`DELETE FROM ${t} WHERE session_id = ?`, [s.sessionId]);
      for (const c of r.toolCalls)
        this.run(
          `INSERT INTO tool_calls(session_id, server_name, tool_name, called_at,
             duration_ms, is_error, response_tokens) VALUES(?,?,?,?,?,?,?)`,
          [c.sessionId, c.serverName, c.toolName, c.calledAt, c.durationMs,
           c.isError ? 1 : 0, c.responseTokens]);
      for (const l of r.toolLoads)
        this.run(
          `INSERT INTO tool_loads(session_id, server_name, tool_name, loaded_tokens)
           VALUES(?,?,?,?)`,
          [l.sessionId, l.serverName, l.toolName, l.loadedTokens]);
      for (const u of r.usage)
        this.run(
          `INSERT INTO token_usage(session_id, at, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens) VALUES(?,?,?,?,?,?)`,
          [u.sessionId, u.at, u.inputTokens, u.outputTokens,
           u.cacheReadTokens, u.cacheCreationTokens]);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  upsertDefinitions(defs: ToolDefinition[]): void {
    for (const d of defs)
      this.run(
        `INSERT INTO tool_definitions(server_name, tool_name, definition_tokens, scanned_at)
         VALUES(?,?,?,?)
         ON CONFLICT(server_name, tool_name) DO UPDATE
           SET definition_tokens=excluded.definition_tokens, scanned_at=excluded.scanned_at`,
        [d.serverName, d.toolName, d.definitionTokens, d.scannedAt]);
  }

  getCursor(filePath: string): { byteOffset: number; mtimeMs: number } | null {
    const rows = this.select(
      'SELECT byte_offset, mtime_ms FROM file_cursors WHERE file_path=?', [filePath]);
    return rows.length
      ? { byteOffset: rows[0].byte_offset as number, mtimeMs: rows[0].mtime_ms as number }
      : null;
  }
  setCursor(filePath: string, byteOffset: number, mtimeMs: number): void {
    this.run(
      `INSERT INTO file_cursors(file_path, byte_offset, mtime_ms) VALUES(?,?,?)
       ON CONFLICT(file_path) DO UPDATE SET byte_offset=excluded.byte_offset, mtime_ms=excluded.mtime_ms`,
      [filePath, byteOffset, mtimeMs]);
  }

  allDefinitions(): ToolDefinition[] {
    return this.select('SELECT * FROM tool_definitions', []).map((r) => ({
      serverName: r.server_name as string, toolName: r.tool_name as string,
      definitionTokens: r.definition_tokens as number, scannedAt: r.scanned_at as string,
    }));
  }
  callsSince(iso: string): ToolCallEvent[] {
    return this.select(
      `SELECT * FROM tool_calls WHERE called_at IS NULL OR called_at >= ?`, [iso]
    ).map((r) => ({
      sessionId: r.session_id as string, serverName: r.server_name as string,
      toolName: r.tool_name as string, calledAt: r.called_at as string | null,
      durationMs: r.duration_ms as number | null, isError: r.is_error === 1,
      responseTokens: r.response_tokens as number | null, responseText: null,
    }));
  }
  loadsSince(_iso: string): ToolLoadEvent[] {
    return this.select('SELECT * FROM tool_loads', []).map((r) => ({
      sessionId: r.session_id as string, serverName: r.server_name as string | null,
      toolName: r.tool_name as string, loadedTokens: r.loaded_tokens as number | null,
    }));
  }
  sessionsSince(iso: string): SessionMeta[] {
    return this.select(
      `SELECT * FROM sessions WHERE started_at IS NULL OR started_at >= ?`, [iso]
    ).map((r) => ({
      sessionId: r.session_id as string, client: r.client as SessionMeta['client'],
      filePath: r.file_path as string, startedAt: r.started_at as string | null,
      mode: r.mode as SessionMeta['mode'],
    }));
  }

  save(): void {
    if (this.filePath === ':memory:') return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, Buffer.from(this.db.export()));
    renameSync(tmp, this.filePath); // 원자적 교체
  }
  close(): void { this.db.close(); }

  private run(sql: string, params: unknown[]): void {
    const st = this.db.prepare(sql); st.run(params as any); st.free();
  }
  private select(sql: string, params: unknown[]): Record<string, unknown>[] {
    const st = this.db.prepare(sql); st.bind(params as any);
    const out: Record<string, unknown>[] = [];
    while (st.step()) out.push(st.getAsObject());
    st.free(); return out;
  }
}
```

빌드가 `schema.sql`을 dist로 복사하도록 core의 build 스크립트에 추가: `"build": "tsc -p tsconfig.json && cp src/store/schema.sql dist/store/"` (T4 소유 파일이지만 package.json 수정은 이 줄 하나만 — 머지 시 T1에 알릴 것).

- [ ] **Step 4: 통과 확인** → PASS 4/4
- [ ] **Step 5: Commit** — `git commit -m "feat: sql.js lens store with idempotent ingest and cursors"`

### Task 6: 정의 스캐너 [T4 · Task 5에 이어서 같은 브랜치]

**Files:**
- Create: `packages/core/src/scanner/scanner.ts`, `packages/core/src/scanner/configs.ts`
- Test: `packages/core/test/scanner/configs.test.ts` (설정 파싱은 유닛), 실서버 기동은 수동 스모크

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk`, `countTokens`, types.ts의 `ToolDefinition`
- Produces:
  ```ts
  export interface McpServerSpec { name: string; command: string; args: string[]; env?: Record<string,string>; }
  export function readClaudeMcpConfig(jsonText: string): McpServerSpec[];  // ~/.claude.json의 mcpServers
  export async function scanServer(spec: McpServerSpec): Promise<ToolDefinition[]>;
  ```

**설계:** ①설정 파서(순수 함수 — 유닛테스트 대상)와 ②실서버 기동(`scanServer` — SDK `StdioClientTransport`로 initialize→tools/list→토크나이즈)을 분리. 정의 토큰 = `countTokens(JSON.stringify({name, description, inputSchema}))`. Windows 대비: spawn은 SDK transport에 위임.

- [ ] **Step 1: 설정 파서의 실패하는 테스트**

```ts
// packages/core/test/scanner/configs.test.ts
import { describe, it, expect } from 'vitest';
import { readClaudeMcpConfig } from '../../src/scanner/configs.js';

describe('readClaudeMcpConfig', () => {
  it('mcpServers 표준 포맷에서 spec 목록을 뽑는다', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    expect(readClaudeMcpConfig(json)).toEqual([
      { name: 'github', command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'], env: undefined },
    ]);
  });
  it('mcpServers가 없으면 빈 배열', () => {
    expect(readClaudeMcpConfig('{}')).toEqual([]);
  });
  it('깨진 JSON이면 빈 배열 (throw 금지)', () => {
    expect(readClaudeMcpConfig('{oops')).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인 → 구현**

```ts
// packages/core/src/scanner/configs.ts
export interface McpServerSpec {
  name: string; command: string; args: string[]; env?: Record<string, string>;
}
export function readClaudeMcpConfig(jsonText: string): McpServerSpec[] {
  try {
    const cfg = JSON.parse(jsonText);
    const servers = cfg.mcpServers ?? {};
    return Object.entries(servers).flatMap(([name, s]: [string, any]) =>
      typeof s?.command === 'string'
        ? [{ name, command: s.command, args: s.args ?? [], env: s.env }]
        : []);
  } catch { return []; }
}
```

```ts
// packages/core/src/scanner/scanner.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { countTokens } from '../tokenize.js';
import type { ToolDefinition } from '../types.js';
import type { McpServerSpec } from './configs.js';

export async function scanServer(
  spec: McpServerSpec, timeoutMs = 15000,
): Promise<ToolDefinition[]> {
  const transport = new StdioClientTransport({
    command: spec.command, args: spec.args, env: spec.env,
  });
  const client = new Client({ name: 'mcp-lens-scanner', version: '0.1.0' });
  const timer = setTimeout(() => transport.close(), timeoutMs);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const now = new Date().toISOString();
    return tools.map((t) => ({
      serverName: spec.name,
      toolName: t.name,
      definitionTokens: countTokens(
        JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      scannedAt: now,
    }));
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
```

- [ ] **Step 3: 유닛 통과 확인** → PASS. **실서버 스모크는 Wave 4로 이월** (실기기 자원 독점 규칙 — 0-1).
- [ ] **Step 4: Commit** — `git commit -m "feat: mcp definition scanner (config parser + stdio scan)"`

### Wave 1 싱크 포인트 [T1에서만]

- [ ] 4개 브랜치 각각 `npm test` 통과 확인
- [ ] T1에서 순서대로 머지: claude → codex → gemini → store-scanner (`--no-ff`)
- [ ] 머지 후 루트에서 `npm test` 전체 통과 + `npm run build` 통과
- [ ] worktree 정리, Wave 2 브랜치 분기: `feat/engine`(T1), `feat/watch`(T2)

---

## 4. Wave 2 — 터미널 2개 병렬

### Task 7: 분석 엔진 [T1 · feat/engine]

**Files:**
- Create: `packages/core/src/engine/engine.ts`
- Test: `packages/core/test/engine/engine.test.ts`

**Interfaces:**
- Consumes: types.ts만 (순수 함수 — DB 없이 배열 입력). Gemini 이름 모호성 보정을 위해 definitions의 서버 이름 목록 사용
- Produces (CLI·대시보드·플러그인이 소비):
  ```ts
  export interface EngineInput {
    definitions: ToolDefinition[];
    calls: ToolCallEvent[];
    loads: ToolLoadEvent[];
    sessions: SessionMeta[];
  }
  export function buildMatrix(input: EngineInput): MatrixRow[];
  export function sessionSavings(input: EngineInput): {
    potentialTokens: number; actualTokens: number; savedTokens: number;
  }; // 잠재 − 실비용 (설계문서 4-1)
  ```

**판정 규칙 (설계문서 7장 기능 1):**
- `callCount === 0 && definitionTokens != null` → `action: 'remove'`
- 같은 서버에서 사용 툴 비율 < 20% && 서버 툴 수 ≥ 10 → 미사용 툴에 `action: 'filter-server'`
- 그 외 사용 툴 → `keep`; definitionTokens가 null이고 호출도 없으면 `unknown`
- 모드 인지 reason: 해당 서버가 등장한 세션들의 지배 모드가 UPFRONT면 `"제거 시 매 세션 약 N토큰 절약"`, DEFERRED_*면 `"절약은 작지만 검색 공간 정리 효과"`. evidenceLabel: 세션 모드가 `DEFERRED_MEASURABLE`이면 '실측', `DEFERRED_ESTIMATED`면 '하한 추정', `UPFRONT`면 '전량 가정', 그 외 '측정 불가'.

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/core/test/engine/engine.test.ts
import { describe, it, expect } from 'vitest';
import { buildMatrix, sessionSavings } from '../../src/engine/engine.js';
import type { EngineInput } from '../../src/engine/engine.js';

const def = (tool: string, tokens: number) => ({
  serverName: 'github', toolName: tool, definitionTokens: tokens,
  scannedAt: '2026-07-19T00:00:00Z' });
const call = (tool: string) => ({
  sessionId: 's1', serverName: 'github', toolName: tool,
  calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError: false,
  responseTokens: 100, responseText: null });
const session = (mode: any) => ({
  sessionId: 's1', client: 'claude-code' as const, filePath: '/f',
  startedAt: '2026-07-10T00:00:00Z', mode });

describe('buildMatrix', () => {
  it('호출 0회 + 정의 있음 → remove 권고', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('800');   // 업프론트 → 크기 명시
    expect(row.recommendation.evidenceLabel).toBe('전량 가정');
  });

  it('지연 로딩 세션에서는 같은 판정, 다른 표기', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('검색 공간');
    expect(row.recommendation.evidenceLabel).toBe('실측');
  });

  it('서버 40툴 중 2개만 사용 → 미사용 툴은 filter-server', () => {
    const defs = Array.from({ length: 40 }, (_, i) => def(`t${i}`, 100));
    const input: EngineInput = {
      definitions: defs, calls: [call('t0'), call('t1')], loads: [],
      sessions: [session('UPFRONT')],
    };
    const rows = buildMatrix(input);
    expect(rows.find((r) => r.toolName === 't5')!.recommendation.action).toBe('filter-server');
    expect(rows.find((r) => r.toolName === 't0')!.recommendation.action).toBe('keep');
  });
});

describe('sessionSavings', () => {
  it('잠재 = 정의 전량, 실비용 = 로드분, 절감 = 차이', () => {
    const input: EngineInput = {
      definitions: [def('a', 500), def('b', 700)],
      calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.potentialTokens).toBe(1200);
    expect(s.actualTokens).toBe(500);  // 로드된 a만 — 이름 조인으로 500 산출
    expect(s.savedTokens).toBe(700);
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: 구현**

```ts
// packages/core/src/engine/engine.ts
import type { MatrixRow, Recommendation, SessionMeta, ToolCallEvent,
  ToolDefinition, ToolLoadEvent } from '../types.js';

export interface EngineInput {
  definitions: ToolDefinition[];
  calls: ToolCallEvent[];
  loads: ToolLoadEvent[];
  sessions: SessionMeta[];
}

export function buildMatrix(input: EngineInput): MatrixRow[] {
  const { definitions, calls, loads, sessions } = input;
  const key = (s: string, t: string) => `${s} ${t}`;

  const callAgg = new Map<string, { n: number; tokens: number }>();
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    const a = callAgg.get(k) ?? { n: 0, tokens: 0 };
    a.n++; a.tokens += c.responseTokens ?? 0;
    callAgg.set(k, a);
  }
  const loadSessions = new Map<string, Set<string>>();
  for (const l of loads) {
    const k = key(l.serverName ?? '', l.toolName);
    (loadSessions.get(k) ?? loadSessions.set(k, new Set()).get(k)!).add(l.sessionId);
  }

  // 서버별 사용률 (filter-server 판정용)
  const byServer = new Map<string, { total: number; used: number }>();
  for (const d of definitions) {
    const s = byServer.get(d.serverName) ?? { total: 0, used: 0 };
    s.total++;
    if ((callAgg.get(key(d.serverName, d.toolName))?.n ?? 0) > 0) s.used++;
    byServer.set(d.serverName, s);
  }

  const dominantMode = pickDominantMode(sessions);

  // 정의된 툴 + 정의 없이 호출만 된 툴의 합집합
  const rows = new Map<string, MatrixRow>();
  for (const d of definitions) rows.set(key(d.serverName, d.toolName), baseRow(d.serverName, d.toolName, d.definitionTokens));
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    if (!rows.has(k)) rows.set(k, baseRow(c.serverName, c.toolName, null));
  }

  for (const [k, row] of rows) {
    const a = callAgg.get(k);
    row.callCount = a?.n ?? 0;
    row.responseTokens = a?.tokens ?? 0;
    row.loadedSessionCount = loadSessions.get(k)?.size ?? 0;
    row.sessionCount = sessions.length;
    row.recommendation = recommend(row, byServer.get(row.serverName), dominantMode);
  }
  return [...rows.values()].sort(
    (x, y) => (y.definitionTokens ?? 0) - (x.definitionTokens ?? 0));
}

export function sessionSavings(input: EngineInput) {
  const potentialTokens = input.definitions.reduce((s, d) => s + d.definitionTokens, 0);
  const defTokens = new Map(input.definitions.map(
    (d) => [`${d.serverName} ${d.toolName}`, d.definitionTokens]));
  const loadedKeys = new Set(input.loads.map((l) => `${l.serverName ?? ''} ${l.toolName}`));
  let actualTokens = 0;
  for (const k of loadedKeys) actualTokens += defTokens.get(k) ?? 0;
  // Codex처럼 loadedTokens가 직접 기록된 경우는 그 값을 우선
  const direct = input.loads.reduce((s, l) => s + (l.loadedTokens ?? 0), 0);
  actualTokens = Math.max(actualTokens, direct);
  return { potentialTokens, actualTokens, savedTokens: potentialTokens - actualTokens };
}

function baseRow(serverName: string, toolName: string, definitionTokens: number | null): MatrixRow {
  return { serverName, toolName, definitionTokens, callCount: 0, responseTokens: 0,
    loadedSessionCount: 0, sessionCount: 0,
    recommendation: { action: 'unknown', reason: '', evidenceLabel: '측정 불가' } };
}

function pickDominantMode(sessions: SessionMeta[]): SessionMeta['mode'] {
  const counts = new Map<SessionMeta['mode'], number>();
  for (const s of sessions) counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
  let best: SessionMeta['mode'] = 'DEFERRED_OPAQUE', n = -1;
  for (const [m, c] of counts) if (c > n) { best = m; n = c; }
  return best;
}

function recommend(
  row: MatrixRow,
  server: { total: number; used: number } | undefined,
  mode: SessionMeta['mode'],
): Recommendation {
  const evidenceLabel =
    mode === 'DEFERRED_MEASURABLE' ? '실측' :
    mode === 'DEFERRED_ESTIMATED' ? '하한 추정' :
    mode === 'UPFRONT' ? '전량 가정' : '측정 불가';
  const sizePhrase = (t: number) =>
    mode === 'UPFRONT'
      ? `제거 시 매 세션 약 ${t}토큰 절약`
      : `절약은 작지만 검색 공간 정리 효과`;

  if (row.callCount === 0 && row.definitionTokens != null) {
    if (server && server.total >= 10 && server.used > 0 && server.used / server.total < 0.2)
      return { action: 'filter-server',
        reason: `서버 ${row.serverName}의 ${server.total}툴 중 ${server.used}개만 사용 — 툴 필터링 권장. ${sizePhrase(row.definitionTokens)}`,
        evidenceLabel };
    return { action: 'remove',
      reason: `정의 ${row.definitionTokens}토큰, 호출 0회 — ${sizePhrase(row.definitionTokens)}`,
      evidenceLabel };
  }
  if (row.callCount > 0) return { action: 'keep', reason: `${row.callCount}회 호출됨`, evidenceLabel };
  return { action: 'unknown', reason: '정의 토큰 미확보 (스캐너 미커버)', evidenceLabel: '측정 불가' };
}
```

- [ ] **Step 4: 통과 확인** → PASS. `index.ts`에 `export * from './engine/engine.js'` 추가 (T1 소유이므로 허용)
- [ ] **Step 5: Commit** — `git commit -m "feat: accounting engine (matrix, mode-aware recommendations, savings)"`

### Task 8: 클라이언트 감지기 [T2 · feat/watch]

**Files:**
- Create: `packages/core/src/detect/detector.ts`
- Test: `packages/core/test/detect/detector.test.ts`

**Interfaces:**
- Consumes: `clientLogRoots`, Node `fs`
- Produces: `export function detectClients(now?: Date): ClientStatus[]` —
  `interface ClientStatus { client: ClientId; installed: boolean; activeWithinDays: number | null }`
  (설치 = 로그 루트 존재, 활성 = 최근 mtime과 now의 일수 차)

- [ ] **Step 1~4 (테스트 → 구현 → 통과):** 파일시스템 의존을 주입 가능하게 — `detectClients(now, rootsOverride?: Map<ClientId, string[]>)`. 테스트는 스크래치 디렉토리에 가짜 로그 파일을 만들어 mtime 기반 활성 판정을 검증한다.

```ts
// packages/core/src/detect/detector.ts
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ClientId } from '../types.js';
import { clientLogRoots } from '../paths.js';

export interface ClientStatus {
  client: ClientId; installed: boolean; activeWithinDays: number | null;
}

const ALL: ClientId[] = ['claude-code', 'codex', 'gemini-cli'];

export function detectClients(
  now = new Date(), rootsOverride?: Map<ClientId, string[]>,
): ClientStatus[] {
  return ALL.map((client) => {
    const roots = rootsOverride?.get(client) ?? clientLogRoots(client);
    const existing = roots.filter((r) => existsSync(r));
    if (existing.length === 0) return { client, installed: false, activeWithinDays: null };
    let latest = 0;
    for (const root of existing)
      for (const f of walkJsonl(root)) latest = Math.max(latest, statSync(f).mtimeMs);
    return {
      client, installed: true,
      activeWithinDays: latest === 0 ? null
        : Math.floor((now.getTime() - latest) / 86_400_000),
    };
  });
}

function walkJsonl(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(p, depth + 1));
    else if (/\.jsonl?$/.test(e.name)) out.push(p);
  }
  return out;
}
```

- [ ] **Step 5: Commit** — `git commit -m "feat: client detector (install + activity via mtime)"`

### Task 9: 로그 워처 + 백필 [T2 · 같은 브랜치, Task 8에 이어서]

**Files:**
- Create: `packages/core/src/watch/watcher.ts`
- Test: `packages/core/test/watch/watcher.test.ts`

**Interfaces:**
- Consumes: `LogAdapter` 3종 구현체, `LensStore`(ingest/cursor/save), chokidar
- Produces (확장·CLI가 소비):
  ```ts
  export class LogWatcher {
    constructor(store: LensStore, adapters: LogAdapter[]);
    async backfill(): Promise<{ files: number; parseErrors: number }>; // 전 세션 1회 파싱
    start(): void;   // chokidar watch — add/change 시 증분 파싱 + 주기적 store.save()
    stop(): Promise<void>;
    on(event: 'ingested', cb: (filePath: string) => void): void; // 상태바 갱신용
  }
  ```

**증분 파싱 규약:** JSONL은 append-only이므로 커서(byte_offset) 이후만 읽고 싶지만, **어댑터의 세션 단위 멱등 ingest(delete→insert)와 충돌**한다. MVP 해법: 변경 감지 시 **파일 전체를 다시 파싱**해 ingest(멱등이므로 안전), 커서는 "이 파일을 이 mtime에서 이미 처리했다"는 스킵 판정에만 사용한다. 수만 건 규모에서 충분하고 로직이 단순하다 (진짜 증분은 로드맵).

- [ ] **Step 1: 실패하는 테스트** — 스크래치 디렉토리에 픽스처를 복사해 가짜 `sessionRoots`를 가진 테스트용 어댑터(ClaudeAdapter를 상속해 roots만 오버라이드)로 `backfill()` → store 조회 검증, 그리고 mtime 동일 시 재파싱 스킵 검증:

```ts
// packages/core/test/watch/watcher.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LensStore } from '../../src/store/store.js';
import { LogWatcher } from '../../src/watch/watcher.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';

class TestClaudeAdapter extends ClaudeAdapter {
  constructor(private root: string) { super(); }
  override sessionRoots() { return [this.root]; }
  override matches(p: string) { return p.endsWith('.jsonl'); }
}

describe('LogWatcher.backfill', () => {
  it('루트의 모든 세션 파일을 파싱해 store에 적재한다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    copyFileSync(
      path.join(__dirname, '../../../../fixtures/claude/session-toolsearch.jsonl'),
      path.join(dir, 's1.jsonl'));
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    const r = await w.backfill();
    expect(r.files).toBe(1);
    expect(store.callsSince('2000-01-01').length).toBeGreaterThan(0);
  });

  it('mtime이 같으면 두 번째 backfill은 스킵한다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const f = path.join(dir, 's1.jsonl');
    copyFileSync(
      path.join(__dirname, '../../../../fixtures/claude/session-toolsearch.jsonl'), f);
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    await w.backfill();
    const r2 = await w.backfill();
    expect(r2.files).toBe(0); // 커서 mtime 일치 → 스킵
  });
});
```

- [ ] **Step 2: 실패 확인 → 구현**

```ts
// packages/core/src/watch/watcher.ts
import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { LogAdapter } from '../types.js';
import type { LensStore } from '../store/store.js';

export class LogWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(private store: LensStore, private adapters: LogAdapter[]) { super(); }

  async backfill(): Promise<{ files: number; parseErrors: number }> {
    let files = 0, parseErrors = 0;
    for (const adapter of this.adapters)
      for (const root of adapter.sessionRoots()) {
        if (!existsSync(root)) continue;
        for (const f of walk(root))
          if (adapter.matches(f) && this.ingestFile(adapter, f)) {
            files++;
          }
      }
    this.store.save();
    return { files, parseErrors };
  }

  start(): void {
    const roots = this.adapters.flatMap((a) => a.sessionRoots()).filter(existsSync);
    this.watcher = chokidar.watch(roots, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500 } });
    const onFile = (f: string) => {
      const adapter = this.adapters.find((a) => a.matches(f));
      if (adapter && this.ingestFile(adapter, f)) {
        this.store.save();
        this.emit('ingested', f);
      }
    };
    this.watcher.on('add', onFile).on('change', onFile);
  }

  async stop(): Promise<void> { await this.watcher?.close(); this.watcher = null; }

  /** 반환: 실제로 파싱·적재했는가 (mtime 커서 일치 시 false) */
  private ingestFile(adapter: LogAdapter, filePath: string): boolean {
    const mtimeMs = statSync(filePath).mtimeMs;
    const cursor = this.store.getCursor(filePath);
    if (cursor && cursor.mtimeMs === mtimeMs) return false;
    const content = readFileSync(filePath, 'utf8');
    // MVP: 전체 재파싱 (ingest가 세션 단위 멱등이므로 안전) — 커서는 스킵 판정용
    this.store.ingest(adapter.parseFile(filePath, content));
    this.store.setCursor(filePath, Buffer.byteLength(content), mtimeMs);
    return true;
  }
}

function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else out.push(p);
  }
  return out;
}
```

- [ ] **Step 3: 통과 확인** → PASS
- [ ] **Step 4: Commit** — `git commit -m "feat: log watcher with backfill and mtime cursor skip"`

### Wave 2 싱크 포인트 [T1]

- [ ] `feat/engine`, `feat/watch` 머지 → 전체 테스트·빌드 통과
- [ ] `index.ts`에 store/scanner/detector/watcher/adapters 전부 re-export 확인 (core 공개 API 완성)
- [ ] Wave 3 브랜치 4개 분기

---

## 5. Wave 3 — 터미널 4개 완전 병렬

### Task 10: CLI `npx mcp-lens` [T1 · feat/cli]

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/main.ts`, `packages/cli/src/report.ts`
- Test: `packages/cli/test/report.test.ts`

**Interfaces:**
- Consumes: core 공개 API 전부 (`LensStore.open(dbPath())`, `LogWatcher.backfill`, `buildMatrix`, `sessionSavings`, `detectClients`)
- Produces: 실행 커맨드 `mcp-lens report [--days 30] [--format table|ai|json]` — `--format ai`는 /lens-audit 플러그인(T4)이 소비하는 **마크다운 요약** (계약: 첫 줄 `# MCP Lens Audit`, 이후 매트릭스 표 + 권고 목록)

**설계:** `report.ts`의 `formatReport(rows: MatrixRow[], savings, format): string`은 순수 함수 → 유닛테스트. `main.ts`는 조립만: open store → backfill → 엔진 → 출력.

- [ ] **Step 1: formatReport의 실패하는 테스트** (remove 권고가 표에 나타나는지, `--format ai` 첫 줄 계약, json 파싱 왕복)

```ts
// packages/cli/test/report.test.ts
import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/report.js';
import type { MatrixRow } from '@mcp-lens/core';

const row: MatrixRow = {
  serverName: 'github', toolName: 'unused', definitionTokens: 800,
  callCount: 0, responseTokens: 0, loadedSessionCount: 0, sessionCount: 10,
  recommendation: { action: 'remove', reason: '정의 800토큰, 호출 0회', evidenceLabel: '실측' },
};
const savings = { potentialTokens: 8000, actualTokens: 1200, savedTokens: 6800 };

describe('formatReport', () => {
  it('table 포맷은 서버/툴/권고를 포함', () => {
    const out = formatReport([row], savings, 'table');
    expect(out).toContain('github');
    expect(out).toContain('remove');
  });
  it('ai 포맷 첫 줄은 # MCP Lens Audit (플러그인 계약)', () => {
    expect(formatReport([row], savings, 'ai').split('\n')[0]).toBe('# MCP Lens Audit');
  });
  it('json 포맷은 파싱 가능', () => {
    const parsed = JSON.parse(formatReport([row], savings, 'json'));
    expect(parsed.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 구현** — `packages/cli/package.json`은 `"bin": { "mcp-lens": "dist/main.js" }`, dependency `"@mcp-lens/core": "*"`. `main.ts`:

```ts
#!/usr/bin/env node
// packages/cli/src/main.ts
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath,
  ClaudeAdapter, CodexAdapter, GeminiAdapter } from '@mcp-lens/core';
import { formatReport } from './report.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'report';
  const days = Number(argValue(args, '--days') ?? '30');
  const format = (argValue(args, '--format') ?? 'table') as 'table' | 'ai' | 'json';
  if (cmd !== 'report') { console.error(`unknown command: ${cmd}`); process.exit(1); }

  const store = await LensStore.open(dbPath());
  const watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]);
  const { files } = await watcher.backfill();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const input = {
    definitions: store.allDefinitions(),
    calls: store.callsSince(since),
    loads: store.loadsSince(since),
    sessions: store.sessionsSince(since),
  };
  console.log(formatReport(buildMatrix(input), sessionSavings(input), format));
  console.error(`(${files} session files backfilled)`);
  store.close();
}
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined;
}
main().catch((e) => { console.error(e); process.exit(1); });
```

`report.ts`는 테이블(고정폭 패딩)·ai(마크다운)·json 3분기 순수 함수로 구현 — 테스트의 3계약을 만족시키는 최소 구현.

- [ ] **Step 3: 통과 + 실기기 스모크** — `npm run build && node packages/cli/dist/main.js report` → 자기 머신 로그로 표가 출력되는지 확인 (0-1의 실기기 규칙: 이 스모크는 DB를 만지므로 다른 터미널이 DB 스모크 중이 아닐 때 실행)
- [ ] **Step 4: Commit** — `git commit -m "feat: mcp-lens cli (report command, table/ai/json)"`

### Task 11: VS Code 확장 [T2 · feat/extension]

**Files:**
- Create: `packages/extension/package.json`, `packages/extension/tsconfig.json`, `packages/extension/src/extension.ts`, `packages/extension/src/statusBar.ts`, `packages/extension/.vscodeignore`
- Test: 유닛은 상태바 텍스트 포매터만 (`packages/extension/test/statusBar.test.ts`) — activation은 F5 수동 스모크

**Interfaces:**
- Consumes: core 공개 API. **`vscode` import는 이 패키지에서만 허용.**
- Produces: `onStartupFinished` activation → detectClients → backfill → watcher.start() → 상태바에 `⌛ Lens: N calls / M천tok saved` 요약, 클릭 시 `mcp-lens.showReport` 커맨드(웹뷰는 대시보드(T3) 완성 전엔 report 텍스트 출력)

- [ ] **Step 1: package.json 계약**

```json
{
  "name": "mcp-lens",
  "displayName": "MCP Lens",
  "version": "0.1.0",
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [{ "command": "mcp-lens.showReport", "title": "MCP Lens: Show Report" }]
  },
  "dependencies": { "@mcp-lens/core": "*" },
  "devDependencies": { "@types/vscode": "^1.90.0" }
}
```

- [ ] **Step 2: 상태바 포매터 TDD** — `formatStatus(callCount: number, savedTokens: number): string` 순수 함수 (`"Lens: 12 calls · 6.8k saved"` 형식, 1000 미만은 그대로, 이상은 `x.xk`) → 테스트 → 구현

- [ ] **Step 3: extension.ts 조립**

```ts
// packages/extension/src/extension.ts
import * as vscode from 'vscode';
import { LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath, detectClients,
  ClaudeAdapter, CodexAdapter, GeminiAdapter } from '@mcp-lens/core';
import { formatStatus } from './statusBar.js';

let watcher: LogWatcher | undefined;
let store: LensStore | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Lens: starting…'; item.command = 'mcp-lens.showReport'; item.show();
  ctx.subscriptions.push(item);

  store = await LensStore.open(dbPath()); // 전역 제약 2: 공유 경로
  const active = detectClients().filter((c) => c.installed);
  watcher = new LogWatcher(store,
    [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]
      .filter((a) => active.some((c) => c.client === a.client)));

  const refresh = () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
      loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
    item.text = formatStatus(input.calls.length, sessionSavings(input).savedTokens);
  };
  await watcher.backfill(); // 시작 시 밀린 세션 따라잡기 (기능 2)
  refresh();
  watcher.on('ingested', refresh);
  watcher.start();

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mcp-lens.showReport', () => {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since) };
      const rows = buildMatrix(input);
      const doc = rows.map((r) =>
        `${r.serverName}/${r.toolName}: ${r.callCount}회, 정의 ${r.definitionTokens ?? '?'}tok → ${r.recommendation.action} (${r.recommendation.reason})`).join('\n');
      vscode.workspace.openTextDocument({ content: doc, language: 'markdown' })
        .then((d) => vscode.window.showTextDocument(d));
    }));
}

export async function deactivate() { await watcher?.stop(); store?.save(); store?.close(); }
```

- [ ] **Step 4: F5 수동 스모크** — Extension Development Host에서 상태바 등장 + showReport 동작 확인 (이 스모크도 공유 DB 사용 — 0-1 규칙 준수)
- [ ] **Step 5: Commit** — `git commit -m "feat: vscode extension (auto backfill, watcher, status bar)"`

### Task 12: 대시보드 [T3 · feat/dashboard]

**Files:**
- Create: `packages/dashboard/package.json`, `packages/dashboard/src/server.ts`, `packages/dashboard/src/app/…`(React: `App.tsx`, `MatrixTable.tsx`, `Timeline.tsx`)
- Test: `packages/dashboard/test/server.test.ts` (HTTP 계약만)

**Interfaces:**
- Consumes: core의 store 조회 + engine
- Produces: `startDashboard(store: LensStore, port: number)` — HTTP 계약:
  - `GET /api/matrix?days=30` → `{ rows: MatrixRow[], savings: {...} }`
  - `GET /api/sessions?days=7` → `SessionMeta[]`
  - `GET /api/timeline/:sessionId` → `ToolCallEvent[]` (시각·소요·성공/실패 — DevTools 스타일 타임라인 데이터)
  - `GET /` → 정적 React 번들

- [ ] **Step 1: server.ts의 HTTP 계약 테스트** — 인메모리 store에 fake 데이터 넣고 `fetch('http://127.0.0.1:PORT/api/matrix')` 검증 (Node 내장 `http` + `fetch`)
- [ ] **Step 2: server.ts 구현** — Node 내장 `http`로 3 엔드포인트 + 정적 서빙 (외부 프레임워크 불요, YAGNI)
- [ ] **Step 3: React 앱** — vite 빌드, `MatrixTable`(권고 색상: remove=빨강, filter=주황, keep=초록), `Timeline`(세션 선택 → 호출 막대). MVP는 폴링(5초 fetch)이며 웹소켓은 이월
- [ ] **Step 4: 수동 스모크** — `node dist/server.js` → 브라우저에서 매트릭스·타임라인 렌더 확인
- [ ] **Step 5: Commit** — `git commit -m "feat: local dashboard (http api + react matrix/timeline)"`

### Task 13: /lens-audit 플러그인 [T4 · feat/plugin]

**Files:**
- Create: `packages/lens-audit-plugin/.claude-plugin/plugin.json`, `packages/lens-audit-plugin/commands/lens-audit.md`, `packages/lens-audit-plugin/README.md`

**Interfaces:**
- Consumes: Task 10의 `--format ai` 출력 계약 (첫 줄 `# MCP Lens Audit`)
- Produces: Claude Code 슬래시 커맨드 `/lens-audit`

- [ ] **Step 1: 플러그인 작성**

`plugin.json`:
```json
{ "name": "mcp-lens", "version": "0.1.0", "description": "MCP context accounting audit" }
```

`commands/lens-audit.md`:
```markdown
---
description: MCP 툴 컨텍스트 낭비 감사 — 비용×사용 매트릭스와 권고를 분석해 조치를 제안
allowed-tools: Bash(npx mcp-lens *)
---

다음 명령을 실행해 MCP Lens의 감사 리포트를 얻어라:

!`npx mcp-lens report --days 30 --format ai`

위 리포트를 바탕으로:
1. 제거 권장(remove) 툴들을 표로 요약하고 예상 절약 토큰을 밝혀라
2. filter-server 권고가 있으면 해당 클라이언트 설정에서 툴을 필터링하는 구체적 방법을 제안하라
3. 근거 라벨(실측/하한 추정/전량 가정)을 함께 표기해 숫자의 신뢰 수준을 명시하라
사용자가 동의하면 설정 수정을 도와라 (수정 전 반드시 백업).
```

- [ ] **Step 2: 수동 검증** — 로컬 플러그인 설치 후 `/lens-audit` 실행이 CLI를 부르고 요약이 나오는지 확인 (CLI 머지 후에만 가능 — T1의 Task 10 머지를 기다리는 **유일한 Wave 3 내부 의존**. 그 전까지는 문서·프롬프트를 다듬는다)
- [ ] **Step 3: Commit** — `git commit -m "feat: /lens-audit claude code plugin"`

### Wave 3 싱크 포인트 [T1]

- [ ] 4개 브랜치 머지 (cli → extension → dashboard → plugin) → 전체 테스트·빌드 통과

---

## 6. Wave 4 — 직렬, 터미널 1개

### Task 14: 통합 E2E + 실기기 스모크

**Files:**
- Create: `packages/core/test/e2e/pipeline.test.ts`
- Create: `docs/SMOKE.md` (수동 체크리스트 기록)

- [ ] **Step 1: 파이프라인 E2E 테스트** — 픽스처 3종 → 어댑터 3종 → store(:memory:) → 엔진 → `MatrixRow[]`에 3개 클라이언트 데이터가 모두 반영되는지 (클라이언트 횡단 조회 — 기능 3의 핵심 주장 검증):

```ts
// packages/core/test/e2e/pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LensStore } from '../../src/store/store.js';
import { buildMatrix } from '../../src/engine/engine.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';
import { GeminiAdapter } from '../../src/adapters/gemini/adapter.js';

const fx = (p: string) => readFileSync(path.join(__dirname, '../../../../fixtures', p), 'utf8');

it('3개 클라이언트 로그가 하나의 매트릭스로 통합된다', async () => {
  const store = await LensStore.open(':memory:');
  store.ingest(new ClaudeAdapter().parseFile('/fx/c.jsonl', fx('claude/session-toolsearch.jsonl')));
  store.ingest(new CodexAdapter().parseFile('/fx/x.jsonl', fx('codex/rollout-codemode.jsonl')));
  store.ingest(new GeminiAdapter().parseFile('/fx/g.jsonl', fx('gemini/chat-upfront.jsonl')));
  const rows = buildMatrix({
    definitions: store.allDefinitions(),
    calls: store.callsSince('2000-01-01'),
    loads: store.loadsSince('2000-01-01'),
    sessions: store.sessionsSince('2000-01-01'),
  });
  expect(rows.length).toBeGreaterThan(0);
  const clients = new Set(store.sessionsSince('2000-01-01').map((s) => s.client));
  expect(clients.size).toBe(3);
});
```

- [ ] **Step 2: 실기기 스모크 (순서대로, 동시 실행 금지)**
  1. `node packages/cli/dist/main.js report` — 자기 머신 106개 세션이 백필되어 표가 나오는가, 소요 시간은 수용 가능한가(목표 < 30초)
  2. 스캐너 실서버: `~/.claude.json`의 실제 서버 1개로 `scanServer` 실행 → definitions가 DB에 적재되고 리포트의 `정의 토큰` 열이 채워지는가
  3. F5 확장: 상태바 → showReport → 새 Claude Code 세션을 하나 굴려 툴콜 발생 → 상태바 숫자가 갱신되는가 (라이브 반영 — 기능 2)
  4. 대시보드: 매트릭스에 remove 권고가 실데이터로 나타나는가 — **발표 시연 시나리오 그대로**
  5. `/lens-audit` — 요약이 컨텍스트에 올라오는가
- [ ] **Step 3: 결과를 docs/SMOKE.md에 기록 후 Commit** — `git commit -m "test: e2e pipeline + smoke record"`

---

## 7. Self-Review 결과 (계획 검증)

- **설계문서 커버리지**: MVP 4종 — 기능 1(Task 6·7·10), 기능 2(Task 9·11), 기능 3(Task 12), 기능 4(Task 13) ✅. 구현 제약 3종 → 전역 제약에 반영 ✅. Tier 2·3 프록시, OpenCode, 훅 트리거 채널, 세션 리플레이는 설계문서 9장 로드맵대로 **의도적 제외** (훅 트리거는 MVP에서 chokidar 폴백으로 대체 — 설계문서도 Gemini에 대해 같은 폴백을 명시).
- **타입 일관성**: `AdapterResult`/`LensStore.ingest`/`EngineInput`/`MatrixRow`의 필드명이 태스크 간 일치함을 교차 확인 ✅.
- **알려진 불확실성 (구현자에게)**: Claude의 `tool_reference` 정확한 레코드 형태, Codex `token_count`의 턴별 필드명, Gemini 레코드의 토큰 분해 필드명은 **픽스처가 진실이다**. 코드 주석에 적어둔 후보 중 픽스처와 일치하는 쪽으로 확정하고, 계약(types.ts)은 손대지 마라.
