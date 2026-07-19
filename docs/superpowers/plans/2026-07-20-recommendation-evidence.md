# 권고 증거·확신 등급 (Recommendation Evidence & Confidence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 삭제 권고에 "얼마나 관찰했는가"를 구조화된 `evidence` + `confidence` 축으로 붙여, 사용자가 "정말 지워도 되나"를 판단할 수 있게 한다.

**Architecture:** `action` 5종은 불변. `Recommendation`에 직교 축 `confidence`(high/medium/low)와 `evidence`(관찰 세션·일수·마지막 호출·누적 부담)를 추가한다. 관찰 창 산정과 확신 규칙은 `packages/core/src/engine/evidence.ts`라는 신규 순수 모듈에 격리하고, `engine.ts`는 그것을 호출만 한다(engine.ts는 이미 205줄 — 규칙 로직까지 넣으면 비대해진다). 관찰 창의 시작점을 위해 `tool_definitions.first_scanned_at` 컬럼과 기존 DB용 마이그레이션을 추가한다.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, sql.js, npm workspaces 모노레포.

## Global Constraints

- 스펙 원본: `docs/superpowers/specs/2026-07-20-recommendation-evidence-design.md`.
- `action` 5종(`remove`/`filter-server`/`inspect`/`keep`/`unknown`)은 **불변**. 새 action 값 금지.
- 점수 모델(0~100) 금지. 규칙은 표 하나로 설명 가능한 수준 유지.
- `evidence`는 **모든 action에 균일하게 채운다** (keep 행에서도 `lastCalledAt`은 유용).
- core에서 `vscode` import 금지. 네이티브 애드온 금지. 경로는 `os.homedir()` + `path.join()`.
- 유닛테스트는 픽스처 + `:memory:` DB만 사용 (터미널 병렬 안전).
- `packages/dashboard/src/**`는 동결 표면 — **수정 금지**. 빌드·테스트 통과만 확인한다.
- 테스트 실행은 리포지토리 루트에서 `npx vitest run <경로>`.
- 커밋 메시지는 기존 관례(`feat(core):`, `fix(core):`, `test:`)를 따른다.

## 스펙 대비 확정한 설계 판단 2건

계획 작성 중 스펙의 빈틈 2개를 발견해 아래와 같이 해소했다. 구현자는 이 결정을 그대로 따른다.

1. **`lastCalledAt`이 스펙대로면 remove 행에서 영원히 null이다.** `remove`는 `callCount === 0`이 전제인데, `callCount`는 분석 창(`callsSince(since)`) 안의 호출만 센다. 같은 창의 `calls`에서 `lastCalledAt`을 뽑으면 remove 행은 항상 null이 되어 "medium = 과거 호출 이력 있음" 등급이 **도달 불가능**해진다. 그런데 이 등급이야말로 스펙 문제 정의(12~13줄, "예전엔 쓰다가 요즘 안 쓰는 툴")의 핵심이다.
   → **해소:** 전 기간 기준 `store.lastCallByTool()`을 추가하고, `EngineInput`에 **선택 필드** `lastCallByTool?: Map<string, string>`로 전달한다.
2. **`EngineInput`에 필수 필드를 추가하면 동결 표면인 dashboard가 깨진다.** 생성 지점이 4곳(`cli/src/main.ts`, `extension/src/extension.ts` ×2, `dashboard/src/server.ts`)이다.
   → **해소:** 위 필드를 **선택(optional)**으로 둔다. 없으면 창 내 호출로 자연 열화(degrade)되며 dashboard는 한 줄도 손대지 않는다. CLI·확장만 채워 넣어 medium 등급을 활성화한다.

---

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `packages/core/src/types.ts` | 공유 계약: `RecommendationEvidence`, `RecommendationConfidence`, `Recommendation` 확장, `ToolDefinition.firstScannedAt` | 1 |
| `packages/core/src/store/schema.sql` | `tool_definitions.first_scanned_at` 컬럼 | 1 |
| `packages/core/src/store/store.ts` | 마이그레이션·백필, upsert 보존, `lastCallByTool()` | 1 |
| `packages/core/src/scanner/scanner.ts` | 스캔 산출물에 `firstScannedAt` 채움 | 1 |
| `packages/core/src/engine/evidence.ts` **(신규)** | 관찰 창 산정 + 확신 등급 규칙 + reason 꼬리말 (순수 함수) | 2 |
| `packages/core/src/engine/engine.ts` | `evidence.ts` 호출해 `Recommendation` 조립 | 3 |
| `packages/cli/src/report.ts` | table/ai 포맷 `확신` 컬럼, ai 권고 정렬·후보 섹션 | 4 |
| `packages/extension/src/matrixTree.ts` + `lensTreeProvider.ts` | low → "후보" 라벨, 아이콘 강조 제외 | 5 |

Task 4와 Task 5는 서로 파일이 겹치지 않으므로 **동시 스폰 가능**하다. Task 1→2→3은 직렬이다.

---

### Task 1: 계약 + 스토어 (`first_scanned_at`)

**Files:**
- Modify: `packages/core/src/types.ts:70-75` (ToolDefinition), `:106-111` (Recommendation)
- Modify: `packages/core/src/store/schema.sql:25-31`
- Modify: `packages/core/src/store/store.ts:14-21` (open), `:55-63` (upsertDefinitions), `:79-84` (allDefinitions)
- Modify: `packages/core/src/scanner/scanner.ts:66`
- Modify: `packages/core/test/engine/engine.test.ts:6-8` (def 헬퍼 — 타입 통과용)
- Modify: `packages/dashboard/test/server.test.ts:44,45,126` (픽스처 리터럴 — 타입 통과용. `src/`는 손대지 않는다)
- Test: `packages/core/test/store/store.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `ToolDefinition.firstScannedAt: string`
  - `type RecommendationConfidence = 'high' | 'medium' | 'low'`
  - `interface RecommendationEvidence { observedSessions: number; observedDays: number | null; lastCalledAt: string | null; costPerSession: number | null; totalObservedCost: number | null }`
  - `Recommendation.confidence: RecommendationConfidence`, `Recommendation.evidence: RecommendationEvidence`
  - `LensStore.lastCallByTool(): Map<string, string>` — 키는 `` `${serverName} ${toolName}` ``

- [ ] **Step 1: 실패하는 스토어 테스트를 쓴다**

`packages/core/test/store/store.test.ts`의 `describe('LensStore', ...)` 블록 안, 마지막 `it` 뒤에 추가:

```ts
  it('upsert를 2회 해도 first_scanned_at은 최초값을 보존한다', async () => {
    const s = await LensStore.open(':memory:');
    s.upsertDefinitions([{ serverName: 'github', toolName: 'a',
      definitionTokens: 100, scannedAt: '2026-01-01T00:00:00Z',
      firstScannedAt: '2026-01-01T00:00:00Z' }]);
    s.upsertDefinitions([{ serverName: 'github', toolName: 'a',
      definitionTokens: 120, scannedAt: '2026-07-01T00:00:00Z',
      firstScannedAt: '2026-07-01T00:00:00Z' }]);
    const [d] = s.allDefinitions();
    expect(d.definitionTokens).toBe(120);              // 최신값으로 갱신
    expect(d.scannedAt).toBe('2026-07-01T00:00:00Z');  // 최신값으로 갱신
    expect(d.firstScannedAt).toBe('2026-01-01T00:00:00Z'); // 최초값 보존
  });

  it('first_scanned_at 없는 구스키마 DB를 열면 컬럼이 추가되고 scanned_at으로 백필된다', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lens-migrate-${Date.now()}.db`;
    // 구스키마 DB를 손으로 만든다 (first_scanned_at 컬럼 없음)
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(`CREATE TABLE tool_definitions (
      server_name TEXT NOT NULL, tool_name TEXT NOT NULL,
      definition_tokens INTEGER NOT NULL, scanned_at TEXT NOT NULL,
      PRIMARY KEY (server_name, tool_name));
      INSERT INTO tool_definitions VALUES('github','old',700,'2026-02-02T00:00:00Z');`);
    writeFileSync(tmp, Buffer.from(legacy.export()));
    legacy.close();

    const s = await LensStore.open(tmp);
    const [d] = s.allDefinitions();
    expect(d.toolName).toBe('old');
    expect(d.firstScannedAt).toBe('2026-02-02T00:00:00Z'); // scanned_at으로 백필
    s.close();
  });

  it('lastCallByTool은 전 기간 기준 툴별 마지막 호출 시각을 준다', async () => {
    const s = await LensStore.open(':memory:');
    const old = fakeResult('old', 0);
    old.session.startedAt = '2026-01-01T00:00:00Z';
    old.toolCalls = [{ sessionId: 'old', serverName: 'github', toolName: 'stale',
      calledAt: '2026-01-05T00:00:00Z', durationMs: 1, isError: false,
      responseTokens: 10, responseText: null }];
    s.ingest(old);
    expect(s.lastCallByTool().get('github stale')).toBe('2026-01-05T00:00:00Z');
    expect(s.lastCallByTool().get('github ghost')).toBeUndefined();
  });
```

같은 파일 상단 import에 추가:

```ts
import initSqlJs from 'sql.js';
import { writeFileSync } from 'node:fs';
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run packages/core/test/store/store.test.ts`
Expected: FAIL — 타입 오류(`firstScannedAt`가 `ToolDefinition`에 없음) 및 `s.lastCallByTool is not a function`

- [ ] **Step 3: `types.ts` 계약을 넓힌다**

`packages/core/src/types.ts`의 `ToolDefinition`을 교체:

```ts
/** 정의 스캐너 산출물 (비용 축) */
export interface ToolDefinition {
  serverName: string;
  toolName: string;
  definitionTokens: number;
  scannedAt: string;
  /** 이 정의를 처음 관찰한 시각 (ISO). 관찰 창의 시작점 후보 — upsert로 덮이지 않는다 */
  firstScannedAt: string;
}
```

같은 파일 맨 끝의 `Recommendation`을 교체:

```ts
export type RecommendationConfidence = 'high' | 'medium' | 'low';

/** 권고의 관찰 근거 — 모든 action에 균일하게 채운다 (keep에서도 lastCalledAt은 유용) */
export interface RecommendationEvidence {
  /** 이 툴을 관찰한 것으로 인정되는 세션 수 */
  observedSessions: number;
  /** 관찰 창 길이 (일). 산정 불가 시 null */
  observedDays: number | null;
  /** 마지막 호출 시각 (ISO). 호출 이력 전무면 null */
  lastCalledAt: string | null;
  /** 세션당 부담 토큰 (= definitionTokens, 미확보 시 null) */
  costPerSession: number | null;
  /** 관찰 기간 누적 부담 (= costPerSession × observedSessions) */
  totalObservedCost: number | null;
}

export interface Recommendation {
  action: 'remove' | 'filter-server' | 'keep' | 'unknown' | 'inspect';
  /** action과 직교하는 축 — action="무엇을 하라", confidence="얼마나 믿을 수 있나" */
  confidence: RecommendationConfidence;
  /** 모드 인지 표기: 업프론트면 "매 세션 N토큰 절약", 지연이면 "검색 공간 정리" */
  reason: string;
  evidenceLabel: '실측' | '하한 추정' | '전량 가정' | '측정 불가';
  evidence: RecommendationEvidence;
}
```

- [ ] **Step 4: 스키마에 컬럼을 추가한다**

`packages/core/src/store/schema.sql`의 `tool_definitions` 정의를 교체:

```sql
CREATE TABLE IF NOT EXISTS tool_definitions (
  server_name       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  definition_tokens INTEGER NOT NULL,
  scanned_at        TEXT NOT NULL,
  first_scanned_at  TEXT,
  PRIMARY KEY (server_name, tool_name)
);
```

- [ ] **Step 5: 스토어에 마이그레이션·보존·조회를 넣는다**

`packages/core/src/store/store.ts`의 `open`을 교체:

```ts
  static async open(filePath: string): Promise<LensStore> {
    const SQL = await initSqlJs();
    const db = filePath !== ':memory:' && existsSync(filePath)
      ? new SQL.Database(readFileSync(filePath))
      : new SQL.Database();
    db.exec(SCHEMA);
    migrate(db);
    return new LensStore(db, filePath);
  }
```

같은 파일, `export class LensStore` **바로 위**에 추가:

```ts
/**
 * schema.sql은 CREATE TABLE IF NOT EXISTS라 기존 DB에는 새 컬럼이 생기지 않는다.
 * 열 때마다 실제 컬럼 목록을 보고 없으면 추가·백필한다 (멱등).
 */
function migrate(db: Database): void {
  const cols = new Set<string>();
  const st = db.prepare('PRAGMA table_info(tool_definitions)');
  while (st.step()) cols.add(st.getAsObject().name as string);
  st.free();
  if (!cols.has('first_scanned_at')) {
    db.exec('ALTER TABLE tool_definitions ADD COLUMN first_scanned_at TEXT');
    db.exec('UPDATE tool_definitions SET first_scanned_at = scanned_at');
  }
}
```

`upsertDefinitions`를 교체:

```ts
  upsertDefinitions(defs: ToolDefinition[]): void {
    for (const d of defs)
      this.run(
        `INSERT INTO tool_definitions(server_name, tool_name, definition_tokens,
           scanned_at, first_scanned_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(server_name, tool_name) DO UPDATE
           SET definition_tokens=excluded.definition_tokens,
               scanned_at=excluded.scanned_at,
               first_scanned_at=COALESCE(tool_definitions.first_scanned_at,
                                         excluded.first_scanned_at)`,
        [d.serverName, d.toolName, d.definitionTokens, d.scannedAt, d.firstScannedAt]);
  }
```

`allDefinitions`를 교체:

```ts
  allDefinitions(): ToolDefinition[] {
    return this.select('SELECT * FROM tool_definitions', []).map((r) => ({
      serverName: r.server_name as string, toolName: r.tool_name as string,
      definitionTokens: r.definition_tokens as number, scannedAt: r.scanned_at as string,
      // 마이그레이션 직후·구행 방어: 값이 없으면 scanned_at을 최초 관찰로 간주
      firstScannedAt: (r.first_scanned_at as string | null) ?? (r.scanned_at as string),
    }));
  }
```

`sessionsSince` 메서드 **바로 뒤**에 추가:

```ts
  /**
   * 전 기간 기준 툴별 마지막 호출 시각. 키는 `${serverName} ${toolName}`.
   * 분석 창(callsSince) 밖의 과거 사용 이력을 확신 등급에 반영하기 위한 것 —
   * 창 안 호출만 보면 "예전엔 쓰던 툴"과 "한 번도 안 쓴 툴"이 구분되지 않는다.
   */
  lastCallByTool(): Map<string, string> {
    const rows = this.select(
      `SELECT server_name, tool_name, MAX(called_at) AS last_called_at
       FROM tool_calls WHERE called_at IS NOT NULL
       GROUP BY server_name, tool_name`, []);
    return new Map(rows.map((r) => [
      `${r.server_name as string} ${r.tool_name as string}`,
      r.last_called_at as string,
    ]));
  }
```

- [ ] **Step 6: 생산자·픽스처를 새 계약에 맞춘다**

`packages/core/src/scanner/scanner.ts:66` — `scannedAt: now,` 를 다음 두 줄로 교체:

```ts
      scannedAt: now,
      firstScannedAt: now, // 저장 시 COALESCE가 기존 최초값을 지켜준다
```

`packages/core/test/engine/engine.test.ts:6-8`의 `def` 헬퍼를 교체:

```ts
const def = (tool: string, tokens: number) => ({
  serverName: 'github', toolName: tool, definitionTokens: tokens,
  scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });
```

`packages/dashboard/test/server.test.ts`의 3개 리터럴(44·45·126행)에 각각 `firstScannedAt: FIXED_ISO,`를 `scannedAt: FIXED_ISO` 뒤에 추가한다. 예:

```ts
      { serverName: 'github', toolName: 'search_issues', definitionTokens: 500, scannedAt: FIXED_ISO, firstScannedAt: FIXED_ISO },
```

- [ ] **Step 7: 테스트를 돌려 통과를 확인한다**

Run: `npx vitest run packages/core/test/store/store.test.ts`
Expected: PASS — 신규 3개 포함 전부 통과

Run: `npx vitest run`
Expected: PASS — 기존 스위트 회귀 없음 (engine/dashboard 픽스처 갱신 덕에 타입 통과)

- [ ] **Step 8: 커밋**

```bash
git add packages/core/src/types.ts packages/core/src/store/schema.sql \
  packages/core/src/store/store.ts packages/core/src/scanner/scanner.ts \
  packages/core/test/store/store.test.ts packages/core/test/engine/engine.test.ts \
  packages/dashboard/test/server.test.ts
git commit -m "feat(core): 권고 증거 계약 + tool_definitions.first_scanned_at 마이그레이션"
```

---

### Task 2: 관찰 창·확신 등급 순수 모듈 (`evidence.ts`)

**Files:**
- Create: `packages/core/src/engine/evidence.ts`
- Test: `packages/core/test/engine/evidence.test.ts` (신규)

**Interfaces:**
- Consumes: Task 1의 `RecommendationEvidence`, `RecommendationConfidence`, `ToolDefinition.firstScannedAt`
- Produces:
  - `interface EvidenceContext` (불투명 — Task 3은 만들어 넘기기만 한다)
  - `buildEvidenceContext(definitions: ToolDefinition[], calls: ToolCallEvent[], loads: ToolLoadEvent[], sessions: SessionMeta[], lastCallAllTime?: Map<string, string>): EvidenceContext`
  - `toolEvidence(serverName: string, toolName: string, definitionTokens: number | null, ctx: EvidenceContext): RecommendationEvidence`
  - `removeConfidence(ev: RecommendationEvidence): RecommendationConfidence`
  - `inspectConfidence(callCount: number): RecommendationConfidence`
  - `confidencePhrase(confidence: RecommendationConfidence, ev: RecommendationEvidence): string`
  - `EMPTY_EVIDENCE: RecommendationEvidence`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Create `packages/core/test/engine/evidence.test.ts`:

```ts
// packages/core/test/engine/evidence.test.ts
import { describe, it, expect } from 'vitest';
import { buildEvidenceContext, toolEvidence, removeConfidence, inspectConfidence,
  confidencePhrase } from '../../src/engine/evidence.js';
import type { SessionMeta, ToolDefinition } from '../../src/types.js';

const DAY = 86_400_000;
const iso = (dayOffset: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + dayOffset * DAY).toISOString();

const def = (firstScannedAt: string): ToolDefinition => ({
  serverName: 'github', toolName: 't', definitionTokens: 800,
  scannedAt: iso(30), firstScannedAt });

/** n개 세션을 하루 간격으로 만든다 (s0 = day0, s1 = day1, ...) */
const sessions = (n: number, from = 0): SessionMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `s${from + i}`, client: 'claude-code' as const,
    filePath: `/f/${from + i}`, startedAt: iso(from + i),
    mode: 'UPFRONT' as const }));

describe('관찰 창 산정', () => {
  it('정의 최초 관찰 이후 세션만 창에 든다 (방금 추가된 서버 과대평가 방지)', () => {
    // 세션은 day0~day9, 정의는 day7에 처음 스캔됨, 서버 활동 증거 없음
    const ctx = buildEvidenceContext([def(iso(7))], [], [], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(3);   // day7, day8, day9만
    expect(ev.observedDays).toBe(2);       // day7 ~ day9
  });

  it('서버 활동(호출)이 있는 더 이른 세션이 있으면 창이 확장된다', () => {
    // 정의는 day7 스캔이지만 day2 세션에 이 서버 호출이 있었다 → 창 시작 day2
    const calls = [{ sessionId: 's2', serverName: 'github', toolName: 'other',
      calledAt: iso(2), durationMs: 1, isError: false,
      responseTokens: 10, responseText: null }];
    const ctx = buildEvidenceContext([def(iso(7))], calls, [], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(8);   // day2 ~ day9
    expect(ev.observedDays).toBe(7);
  });

  it('startedAt이 null인 세션은 창 판정 불가 → 포함한다 (과소평가 방지)', () => {
    const withNull: SessionMeta[] = [...sessions(3),
      { sessionId: 'sx', client: 'claude-code', filePath: '/f/x',
        startedAt: null, mode: 'UPFRONT' }];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], withNull);
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);
  });

  it('누적 부담 = 세션당 부담 × 관찰 세션 수, 정의 미확보면 null', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(5));
    expect(toolEvidence('github', 't', 800, ctx).totalObservedCost).toBe(4000);
    const none = toolEvidence('github', 'nodef', null, ctx);
    expect(none.costPerSession).toBeNull();
    expect(none.totalObservedCost).toBeNull();
  });

  it('lastCalledAt은 창 안 호출과 전 기간 이력 중 더 나중을 쓴다', () => {
    const allTime = new Map([['github t', iso(-40)]]);
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(3), allTime);
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBe(iso(-40));
  });
});

describe('확신 등급 규칙', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('10세션·7일·호출 이력 없음 → high', () => {
    expect(removeConfidence(ev(12, 20))).toBe('high');
  });

  it('충분히 관찰했지만 과거 호출 이력 있음 → medium', () => {
    expect(removeConfidence(ev(12, 20, '2026-01-01T00:00:00Z'))).toBe('medium');
  });

  it('5~9세션 → medium', () => {
    expect(removeConfidence(ev(6, 20))).toBe('medium');
  });

  it('5세션 미만 → low', () => {
    expect(removeConfidence(ev(3, 20))).toBe('low');
  });

  it('observedDays 3일 미만이면 세션이 많아도 low (낮은 쪽이 이긴다)', () => {
    expect(removeConfidence(ev(50, 1))).toBe('low');
  });

  it('observedDays가 null이면 low', () => {
    expect(removeConfidence(ev(50, null))).toBe('low');
  });

  it('inspect는 표본 10회 이상 high, 3~9회 medium', () => {
    expect(inspectConfidence(10)).toBe('high');
    expect(inspectConfidence(4)).toBe('medium');
  });
});

describe('reason 꼬리말', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('low는 관찰 부족과 확정 아님을 명시한다', () => {
    const s = confidencePhrase('low', ev(2, 1));
    expect(s).toContain('관찰 부족');
    expect(s).toContain('10세션');
    expect(s).toContain('확정 권고 아님');
  });

  it('과거 호출 있는 medium은 마지막 호출일과 지연 로딩 대안을 명시한다', () => {
    const s = confidencePhrase('medium', ev(12, 20, '2026-03-14T09:00:00Z'));
    expect(s).toContain('2026-03-14');
    expect(s).toContain('지연 로딩');
  });

  it('high는 관찰량·누적 부담·복구 용이함을 담는다', () => {
    const s = confidencePhrase('high', ev(12, 20));
    expect(s).toContain('12세션');
    expect(s).toContain('9600');   // 800 × 12
    expect(s).toContain('복구');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run packages/core/test/engine/evidence.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/engine/evidence.js"`

- [ ] **Step 3: `evidence.ts`를 구현한다**

Create `packages/core/src/engine/evidence.ts`:

```ts
// packages/core/src/engine/evidence.ts
// 권고의 "얼마나 관찰했는가"를 산정하는 순수 모듈.
// engine.ts는 이 결과를 Recommendation에 조립하기만 한다.
import type { RecommendationConfidence, RecommendationEvidence, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';

/** high 확신에 필요한 최소 관찰량 — reason 문구의 "N세션 누적 시 확정"에도 쓰인다 */
export const HIGH_CONFIDENCE_SESSIONS = 10;
const HIGH_CONFIDENCE_DAYS = 7;
const LOW_CONFIDENCE_SESSIONS = 5;
const LOW_CONFIDENCE_DAYS = 3;
/** inspect 표본이 이 이상이면 high */
const INSPECT_HIGH_CALLS = 10;
const MS_PER_DAY = 86_400_000;

export const EMPTY_EVIDENCE: RecommendationEvidence = {
  observedSessions: 0, observedDays: null, lastCalledAt: null,
  costPerSession: null, totalObservedCost: null,
};

const key = (server: string, tool: string) => `${server} ${tool}`;

/** ISO 문자열 → epoch ms. 파싱 불가·null은 null (문자열 비교는 오프셋 표기가 섞이면 틀린다) */
function ms(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export interface EvidenceContext {
  sessions: SessionMeta[];
  /** 서버명 → 그 서버의 활동(호출·로드)이 있는 가장 이른 세션 startedAt */
  serverFirstActivity: Map<string, string>;
  /** 스코프 내 최대 세션 startedAt — 창의 끝 */
  windowEnd: string | null;
  /** "server tool" → 창 안 마지막 호출 시각 */
  lastCallInScope: Map<string, string>;
  /** "server tool" → 전 기간 마지막 호출 시각 (창 밖 과거 사용 포함) */
  lastCallAllTime: Map<string, string>;
  /** "server tool" → firstScannedAt */
  firstScanned: Map<string, string>;
}

export function buildEvidenceContext(
  definitions: ToolDefinition[],
  calls: ToolCallEvent[],
  loads: ToolLoadEvent[],
  sessions: SessionMeta[],
  lastCallAllTime: Map<string, string> = new Map(),
): EvidenceContext {
  const startedAt = new Map(sessions.map((s) => [s.sessionId, s.startedAt]));

  // 스캔 전 세션이라도 그 서버의 호출·로드가 있으면 "서버가 구성돼 있었다"는 증거 → 창을 확장한다.
  const serverFirstActivity = new Map<string, string>();
  const noteActivity = (server: string | null, sessionId: string) => {
    if (server == null) return;
    const at = startedAt.get(sessionId) ?? null;
    if (at == null) return;
    const prev = serverFirstActivity.get(server);
    if (prev === undefined || (ms(at) ?? Infinity) < (ms(prev) ?? Infinity))
      serverFirstActivity.set(server, at);
  };
  for (const c of calls) noteActivity(c.serverName, c.sessionId);
  for (const l of loads) noteActivity(l.serverName, l.sessionId);

  let windowEnd: string | null = null;
  for (const s of sessions) {
    const at = ms(s.startedAt);
    if (at == null) continue;
    if (windowEnd === null || at > (ms(windowEnd) ?? -Infinity)) windowEnd = s.startedAt;
  }

  const lastCallInScope = new Map<string, string>();
  for (const c of calls) {
    const at = ms(c.calledAt);
    if (at == null) continue;
    const k = key(c.serverName, c.toolName);
    const prev = lastCallInScope.get(k);
    if (prev === undefined || at > (ms(prev) ?? -Infinity)) lastCallInScope.set(k, c.calledAt!);
  }

  const firstScanned = new Map(
    definitions.map((d) => [key(d.serverName, d.toolName), d.firstScannedAt]));

  return { sessions, serverFirstActivity, windowEnd, lastCallInScope,
    lastCallAllTime, firstScanned };
}

export function toolEvidence(
  serverName: string,
  toolName: string,
  definitionTokens: number | null,
  ctx: EvidenceContext,
): RecommendationEvidence {
  const k = key(serverName, toolName);
  // 창 시작 = min(정의 최초 관찰, 서버 최초 활동).
  // 둘 다 없으면(정의 미확보 + 활동 세션 startedAt 없음) 창 하한이 없다.
  const bounds = [ms(ctx.firstScanned.get(k)), ms(ctx.serverFirstActivity.get(serverName))]
    .filter((v): v is number => v != null);
  const windowStart = bounds.length ? Math.min(...bounds) : null;
  const windowEnd = ms(ctx.windowEnd);

  let observedSessions = 0;
  for (const s of ctx.sessions) {
    const at = ms(s.startedAt);
    // startedAt 없는 세션은 창 판정 불가 → 포함 (과소평가 방지, 문서화된 한계)
    if (at == null) { observedSessions++; continue; }
    if (windowStart != null && at < windowStart) continue;
    if (windowEnd != null && at > windowEnd) continue;
    observedSessions++;
  }

  const observedDays =
    observedSessions === 0 || windowStart == null || windowEnd == null
      ? null
      : Math.max(0, Math.round((windowEnd - windowStart) / MS_PER_DAY));

  // 창 안 호출과 전 기간 이력 중 더 나중 — 전 기간 맵이 없으면 창 안 값으로 자연 열화
  const inScope = ctx.lastCallInScope.get(k) ?? null;
  const allTime = ctx.lastCallAllTime.get(k) ?? null;
  const lastCalledAt =
    inScope == null ? allTime
    : allTime == null ? inScope
    : (ms(allTime) ?? 0) > (ms(inScope) ?? 0) ? allTime : inScope;

  const costPerSession = definitionTokens;
  return {
    observedSessions,
    observedDays,
    lastCalledAt,
    costPerSession,
    totalObservedCost: costPerSession == null ? null : costPerSession * observedSessions,
  };
}

/**
 * remove / filter-server의 확신 등급.
 * 경계가 겹치면 낮은 쪽이 이긴다 — low 조건을 먼저 본다.
 */
export function removeConfidence(ev: RecommendationEvidence): RecommendationConfidence {
  if (ev.observedSessions < LOW_CONFIDENCE_SESSIONS) return 'low';
  if (ev.observedDays == null || ev.observedDays < LOW_CONFIDENCE_DAYS) return 'low';
  if (ev.observedSessions >= HIGH_CONFIDENCE_SESSIONS
    && ev.observedDays >= HIGH_CONFIDENCE_DAYS
    && ev.lastCalledAt == null) return 'high';
  return 'medium';
}

/** inspect는 기존 게이트(호출 ≥3, 실패율 ≥50%)를 통과한 뒤 표본 크기로만 등급을 나눈다 */
export function inspectConfidence(callCount: number): RecommendationConfidence {
  return callCount >= INSPECT_HIGH_CALLS ? 'high' : 'medium';
}

/** remove/filter-server reason에 붙는 확신 꼬리말 */
export function confidencePhrase(
  confidence: RecommendationConfidence,
  ev: RecommendationEvidence,
): string {
  const days = ev.observedDays == null ? '' : `/${ev.observedDays}일`;
  if (confidence === 'low')
    return ` — 관찰 부족(${ev.observedSessions}세션${days}), `
      + `${HIGH_CONFIDENCE_SESSIONS}세션 누적 시 확정. 아직 확정 권고 아님`;
  if (confidence === 'medium' && ev.lastCalledAt != null)
    return ` — 마지막 호출 ${ev.lastCalledAt.slice(0, 10)}, 저빈도 툴일 수 있음. `
      + `삭제보다 지연 로딩 유지 검토`;
  if (confidence === 'medium')
    return ` — ${ev.observedSessions}세션${days} 관찰, 추가 관찰 시 확정`;
  return ` — ${ev.observedSessions}세션${days} 관찰, `
    + `누적 부담 ${ev.totalObservedCost ?? 0}토큰. 설정 한 줄로 복구 가능`;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run packages/core/test/engine/evidence.test.ts`
Expected: PASS — 15개 전부 통과 (창 산정 5 + 등급 7 + 문구 3)

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/engine/evidence.ts packages/core/test/engine/evidence.test.ts
git commit -m "feat(core): 관찰 창 산정·확신 등급 규칙 모듈 추가"
```

---

### Task 3: 엔진 배선 (`Recommendation`에 confidence·evidence 조립)

**Files:**
- Modify: `packages/core/src/engine/engine.ts:1-10` (import·EngineInput), `:99-105` (baseRow), `:60-73` (루프), `:145-182` (recommend)
- Modify: `packages/core/src/index.ts` (evidence 모듈 재수출 — 아래 Step 5에서 실제 파일 확인)
- Test: `packages/core/test/engine/engine.test.ts`

**Interfaces:**
- Consumes: Task 2의 `buildEvidenceContext`, `toolEvidence`, `removeConfidence`, `inspectConfidence`, `confidencePhrase`, `EMPTY_EVIDENCE`
- Produces: `EngineInput.lastCallByTool?: Map<string, string>` — CLI·확장이 `store.lastCallByTool()`로 채운다. 없으면 창 안 호출로 열화.

- [ ] **Step 1: 실패하는 엔진 테스트를 쓴다**

`packages/core/test/engine/engine.test.ts` 맨 끝에 추가:

```ts
describe('확신 등급 (evidence 축)', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const sess = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const scanned = (first: string) => ({
    serverName: 'github', toolName: 'unused', definitionTokens: 800,
    scannedAt: at(0), firstScannedAt: first });

  it('충분히 관찰한 미사용 툴 → remove high + 누적 부담 표기', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(12),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.confidence).toBe('high');
    expect(row.recommendation.evidence.observedSessions).toBe(12);
    expect(row.recommendation.evidence.totalObservedCost).toBe(9600);
    expect(row.recommendation.reason).toContain('복구');
  });

  it('관찰 2세션뿐이면 → remove low + 확정 아님 문구', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(2),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');   // 판정은 강등되지 않는다
    expect(row.recommendation.confidence).toBe('low');  // 표시만 강등
    expect(row.recommendation.reason).toContain('확정 권고 아님');
  });

  it('창 밖 과거 호출 이력이 있으면 → remove medium + 마지막 호출일', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(12),
      lastCallByTool: new Map([['github unused', '2026-03-14T09:00:00Z']]),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.confidence).toBe('medium');
    expect(row.recommendation.evidence.lastCalledAt).toBe('2026-03-14T09:00:00Z');
    expect(row.recommendation.reason).toContain('2026-03-14');
  });

  it('keep은 high 고정, evidence도 채워진다', () => {
    const input: EngineInput = {
      definitions: [def('used', 300)], calls: [call('used')],
      loads: [], sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('keep');
    expect(row.recommendation.confidence).toBe('high');
    expect(row.recommendation.evidence.lastCalledAt).toBe('2026-07-10T00:00:00Z');
  });

  it('unknown은 low 고정', () => {
    const input: EngineInput = {
      definitions: [], calls: [],
      loads: [{ sessionId: 's1', serverName: 'unscanned', toolName: 'ghost', loadedTokens: 10 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('unknown');
    expect(row.recommendation.confidence).toBe('low');
  });

  it('inspect는 표본 크기로 등급이 갈린다', () => {
    const errCall = (i: number) => ({
      sessionId: 's1', serverName: 'github', toolName: 'flaky',
      calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError: i % 2 === 0,
      responseTokens: 100, responseText: null });
    const many: EngineInput = {
      definitions: [def('flaky', 500)],
      calls: Array.from({ length: 12 }, (_, i) => errCall(i)),
      loads: [], sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(many);
    expect(row.recommendation.action).toBe('inspect');
    expect(row.recommendation.confidence).toBe('high');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run packages/core/test/engine/engine.test.ts`
Expected: FAIL — `lastCallByTool`가 `EngineInput`에 없다는 타입 오류, `confidence`가 `undefined`

- [ ] **Step 3: `engine.ts`를 배선한다**

`packages/core/src/engine/engine.ts` 상단 import 블록을 교체:

```ts
// packages/core/src/engine/engine.ts
import type { ClientId, LoadPattern, MatrixRow, Recommendation, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';
import { buildEvidenceContext, confidencePhrase, EMPTY_EVIDENCE, inspectConfidence,
  removeConfidence, toolEvidence, type EvidenceContext } from './evidence.js';

export interface EngineInput {
  definitions: ToolDefinition[];
  calls: ToolCallEvent[];
  loads: ToolLoadEvent[];
  sessions: SessionMeta[];
  /**
   * "server tool" → 전 기간 마지막 호출 시각 (store.lastCallByTool()).
   * 선택 — 없으면 분석 창 안의 호출만으로 판정하며, 창 밖 과거 사용은 보이지 않는다.
   */
  lastCallByTool?: Map<string, string>;
}
```

`buildMatrix` 안, `const dominantMode = pickDominantMode(sessions);` 줄 **바로 뒤**에 추가:

```ts
  const evidenceCtx = buildEvidenceContext(
    definitions, calls, loads, sessions, input.lastCallByTool);
```

같은 함수의 `row.recommendation = recommend(...)` 줄을 교체:

```ts
    row.recommendation = recommend(row, byServer.get(row.serverName), dominantMode, evidenceCtx);
```

`baseRow`의 `recommendation` 초기값을 교체:

```ts
    recommendation: { action: 'unknown', confidence: 'low', reason: '',
      evidenceLabel: '측정 불가', evidence: EMPTY_EVIDENCE },
```

`recommend` 함수 전체를 교체:

```ts
function recommend(
  row: MatrixRow,
  server: { total: number; used: number } | undefined,
  mode: SessionMeta['mode'],
  ctx: EvidenceContext,
): Recommendation {
  const evidence = toolEvidence(row.serverName, row.toolName, row.definitionTokens, ctx);
  const evidenceLabel =
    mode === 'DEFERRED_MEASURABLE' ? '실측' :
    mode === 'DEFERRED_ESTIMATED' ? '하한 추정' :
    mode === 'UPFRONT' ? '전량 가정' : '측정 불가';
  const sizePhrase = (t: number) =>
    mode === 'UPFRONT'
      ? `제거 시 매 세션 약 ${t}토큰 절약`
      : `절약은 작지만 검색 공간 정리 효과`;

  const pollutionSuffix = row.loadPattern === 'search-pollution' ? ' (로드는 되나 호출 0회 — 검색 공간 오염)' : '';

  if (row.callCount === 0 && row.definitionTokens != null) {
    // 확신이 낮아도 판정은 강등하지 않는다 — 표면이 "후보"로 렌더링한다 (스펙 결정사항 2)
    const confidence = removeConfidence(evidence);
    const tail = confidencePhrase(confidence, evidence);
    if (server && server.total >= 10 && server.used > 0 && server.used / server.total < 0.2)
      return { action: 'filter-server', confidence,
        reason: `서버 ${row.serverName}의 ${server.total}툴 중 ${server.used}개만 사용 — 툴 필터링 권장. ${sizePhrase(row.definitionTokens)}${pollutionSuffix}${tail}`,
        evidenceLabel, evidence };
    return { action: 'remove', confidence,
      reason: `정의 ${row.definitionTokens}토큰, 호출 0회 — ${sizePhrase(row.definitionTokens)}${pollutionSuffix}${tail}`,
      evidenceLabel, evidence };
  }
  if (
    row.callCount >= INSPECT_MIN_CALLS &&
    row.reliability.errorRate != null &&
    row.reliability.errorRate >= INSPECT_ERROR_RATE
  ) {
    const rate = Math.round(row.reliability.errorRate * 100);
    return { action: 'inspect', confidence: inspectConfidence(row.callCount),
      reason: `${row.callCount}회 중 ${row.reliability.errorCount}회 실패(${rate}%), 실패 응답 ${row.reliability.failedResponseTokens}토큰 낭비 — 점검·대체 권장`,
      evidenceLabel, evidence };
  }
  // 호출됨 = 자기 증명 → high 고정
  if (row.callCount > 0)
    return { action: 'keep', confidence: 'high',
      reason: `${row.callCount}회 호출됨`, evidenceLabel, evidence };
  return { action: 'unknown', confidence: 'low',
    reason: '정의 토큰 미확보 (스캐너 미커버)', evidenceLabel: '측정 불가', evidence };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run packages/core/test/engine/engine.test.ts`
Expected: PASS — 신규 6개 포함 전부 통과. 기존 `reason).toContain('800')`·`'검색 공간'` 단언은 꼬리말이 붙어도 여전히 성립한다.

- [ ] **Step 5: `evidence.ts`를 패키지 밖으로 재수출한다**

`packages/core/src/index.ts:5`가 `export * from './engine/engine.js';`다. 그 **바로 뒤**(6행 자리)에 한 줄 추가:

```ts
export * from './engine/engine.js';
export * from './engine/evidence.js';
```

- [ ] **Step 6: 전체 스위트와 빌드로 회귀를 확인한다**

Run: `npx vitest run`
Expected: PASS — dashboard 포함 전 패키지 통과

Run: `npm run build`
Expected: 성공 — 동결 표면 dashboard가 새 필드에도 컴파일된다

- [ ] **Step 7: 커밋**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/index.ts \
  packages/core/test/engine/engine.test.ts
git commit -m "feat(core): 권고에 confidence·evidence 축 배선"
```

---

### Task 4: CLI 표면 (`확신` 컬럼 + 후보 섹션)

> Task 3 완료 후 Task 5와 **동시 실행 가능**.

**Files:**
- Modify: `packages/cli/src/report.ts:27` (COLUMNS), `:29-42` (rowCells), `:64-65` (ai 표 헤더), `:70-80` (권고 섹션)
- Modify: `packages/cli/src/main.ts:36-40` (EngineInput에 lastCallByTool 전달)
- Test: `packages/cli/test/report.test.ts`

**Interfaces:**
- Consumes: Task 3의 `MatrixRow['recommendation'].confidence`, `.evidence`; Task 1의 `store.lastCallByTool()`
- Produces: 없음 (말단 표면)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/cli/test/report.test.ts`의 기존 픽스처 2개를 새 계약에 맞춘다.

8행의 `row` 픽스처 `recommendation`을 교체:

```ts
  recommendation: { action: 'remove', confidence: 'high',
    reason: '정의 800토큰, 호출 0회', evidenceLabel: '실측',
    evidence: { observedSessions: 12, observedDays: 20, lastCalledAt: null,
      costPerSession: 800, totalObservedCost: 9600 } },
```

`flakyRow`(inspect, 3회 호출)의 `recommendation`을 교체 — 표본 3회이므로 확신은 `medium`이다:

```ts
      recommendation: {
        action: 'inspect',
        confidence: 'medium',
        reason: '3회 중 2회 실패(67%), 실패 응답 200토큰 낭비 — 점검·대체 권장',
        evidenceLabel: '전량 가정',
        evidence: { observedSessions: 10, observedDays: 20,
          lastCalledAt: '2026-07-10T00:00:00Z',
          costPerSession: 500, totalObservedCost: 5000 },
      },
```

그다음 파일 맨 끝에 추가 (`describe`/`it`/`expect`/`formatReport`/`MatrixRow`는 이미 import돼 있다):

```ts
describe('확신 등급 표면', () => {
  const mk = (tool: string, confidence: 'high' | 'medium' | 'low'): MatrixRow => ({
    serverName: 'github', toolName: tool, definitionTokens: 800, callCount: 0,
    responseTokens: 0, loadedSessionCount: 0, sessionCount: 12,
    recommendation: { action: 'remove', confidence,
      reason: `${tool} 사유`, evidenceLabel: '전량 가정',
      evidence: { observedSessions: 12, observedDays: 20, lastCalledAt: null,
        costPerSession: 800, totalObservedCost: 9600 } },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null,
  });
  const savings = { potentialTokens: 0, actualTokens: 0, savedTokens: 0 };

  it('table 포맷에 확신 컬럼이 나온다', () => {
    const out = formatReport([mk('a', 'high')], savings, 'table');
    expect(out).toContain('확신');
    expect(out).toContain('high');
  });

  it('ai 포맷의 권고는 확신 내림차순이고 low는 후보 섹션으로 분리된다', () => {
    const out = formatReport(
      [mk('lo', 'low'), mk('hi', 'high'), mk('mid', 'medium')], savings, 'ai');
    expect(out).toContain('### 후보 (관찰 부족)');
    // 확정 권고 목록에서는 high가 medium보다 앞
    expect(out.indexOf('github/hi')).toBeLessThan(out.indexOf('github/mid'));
    // low는 후보 섹션 뒤에 온다
    expect(out.indexOf('### 후보 (관찰 부족)')).toBeLessThan(out.indexOf('github/lo'));
  });

  it('low만 있으면 확정 권고는 없다고 알린다', () => {
    const out = formatReport([mk('lo', 'low')], savings, 'ai');
    expect(out).toContain('확정 권고 없음');
    expect(out).toContain('github/lo');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run packages/cli/test/report.test.ts`
Expected: FAIL — `expect(out).toContain('확신')`가 실패

- [ ] **Step 3: `report.ts`에 확신 컬럼을 넣는다**

`packages/cli/src/report.ts:27`의 `COLUMNS`를 교체:

```ts
const COLUMNS = ['server', 'tool', 'defTokens', 'calls', 'respTokens', 'loaded/sessions', '실패율', '실패토큰', 'action', '확신', 'reason'] as const;
```

`rowCells`의 반환 배열에서 `row.recommendation.action,` 뒤에 한 줄 추가:

```ts
    row.recommendation.action,
    row.recommendation.confidence,
    row.recommendation.reason,
```

ai 포맷의 표 헤더 2줄(64-65행)을 교체:

```ts
  lines.push('| server | tool | defTokens | calls | respTokens | loaded/sessions | 실패율 | 실패토큰 | action | 확신 | reason |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
```

- [ ] **Step 4: 권고 섹션을 확신 기준으로 정렬·분리한다**

`formatAi` 안의 `## 권고` 블록(70-80행)을 교체:

```ts
  lines.push('## 권고');
  const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const actionable = rows
    .filter((r) => r.recommendation.action !== 'keep' && r.recommendation.action !== 'unknown')
    .sort((a, b) => RANK[a.recommendation.confidence] - RANK[b.recommendation.confidence]);
  const bullet = (row: MatrixRow) =>
    `- [${row.recommendation.action}·${row.recommendation.confidence}] ${row.serverName}/${row.toolName}: ${row.recommendation.reason} (${row.recommendation.evidenceLabel})`;

  const confirmed = actionable.filter((r) => r.recommendation.confidence !== 'low');
  const candidates = actionable.filter((r) => r.recommendation.confidence === 'low');

  if (actionable.length === 0) {
    lines.push('- 특별한 권고 사항 없음');
  } else if (confirmed.length === 0) {
    lines.push('- 확정 권고 없음 — 관찰량이 쌓이면 아래 후보가 확정된다');
  } else {
    for (const row of confirmed) lines.push(bullet(row));
  }

  if (candidates.length > 0) {
    lines.push('');
    lines.push('### 후보 (관찰 부족)');
    for (const row of candidates) lines.push(bullet(row));
  }
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `npx vitest run packages/cli/test/report.test.ts`
Expected: PASS

- [ ] **Step 6: CLI가 전 기간 호출 이력을 엔진에 넘기게 한다**

`packages/cli/src/main.ts:36-40`의 EngineInput 리터럴에 한 줄 추가 (`sessions:` 줄 뒤):

```ts
    sessions: store.sessionsSince(since),
    lastCallByTool: store.lastCallByTool(),
```

- [ ] **Step 7: 전체 확인 후 커밋**

Run: `npx vitest run packages/cli`
Expected: PASS

```bash
git add packages/cli/src/report.ts packages/cli/src/main.ts packages/cli/test/report.test.ts
git commit -m "feat(cli): 리포트에 확신 컬럼·후보 섹션 추가"
```

---

### Task 5: 확장 표면 (low → "후보" 라벨)

> Task 3 완료 후 Task 4와 **동시 실행 가능**. Task 4와 파일이 겹치지 않는다.

**Files:**
- Modify: `packages/extension/src/matrixTree.ts:5-20` (LensNode), `:62-78` (툴 노드)
- Modify: `packages/extension/src/lensTreeProvider.ts:34` (아이콘)
- Modify: `packages/extension/src/extension.ts:45-46`, `:131-132` (lastCallByTool 전달)
- Test: `packages/extension/test/matrixTree.test.ts`

**Interfaces:**
- Consumes: Task 3의 `MatrixRow['recommendation'].confidence`
- Produces: `LensNode.confidence?: RecommendationConfidence` — 래퍼(`lensTreeProvider.ts`)가 아이콘 강조 판단에 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/extension/test/matrixTree.test.ts` 맨 끝에 추가한다. 이 파일은 이미 `describe`/`it`/`expect`, `buildTree`, `EngineInput` 타입을 import하고 있고 기존 `call`/`session` 헬퍼는 이 테스트에 맞지 않으므로(관찰 창을 넓히려면 세션이 여러 날에 걸쳐야 한다) 아래 전용 헬퍼를 함께 넣는다:

```ts
describe('확신 등급 렌더링', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const sess = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const unusedDef = {
    serverName: 'github', toolName: 'unused', definitionTokens: 800,
    scannedAt: at(0), firstScannedAt: at(0) };

  const toolNode = (sessionCount: number) => {
    const [client] = buildTree({
      definitions: [unusedDef], calls: [], loads: [], sessions: sess(sessionCount) });
    return client.children[0].children[0];
  };

  it('확신 높은 remove는 action 그대로 표시된다', () => {
    const node = toolNode(12);
    expect(node.confidence).toBe('high');
    expect(node.description).toContain('remove');
    expect(node.description).not.toContain('후보');
  });

  it('확신 낮은 remove는 "후보" 라벨로 표시된다', () => {
    const node = toolNode(2);
    expect(node.confidence).toBe('low');
    expect(node.description).toContain('후보');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run packages/extension/test/matrixTree.test.ts`
Expected: FAIL — `node.confidence`가 `undefined`

- [ ] **Step 3: `LensNode`에 confidence를 추가한다**

`packages/extension/src/matrixTree.ts` 상단 import를 교체:

```ts
// packages/extension/src/matrixTree.ts — vscode import 금지 (테스트 가능성)
import type { EngineInput, ManagedServer, MatrixRow, RecommendationConfidence } from '@mcp-lens/core';
import { buildMatrix, mcpDenyRule, splitByClient, visibleMatrixRows } from '@mcp-lens/core';
```

`LensNode`의 `action?` 필드 **바로 뒤**에 추가:

```ts
  /** 'inspect'|'remove' 등 — 래퍼가 아이콘 선택에 사용 */
  action?: MatrixRow['recommendation']['action'];
  /** 확신 등급 — low는 아이콘 강조에서 제외한다 */
  confidence?: RecommendationConfidence;
```

- [ ] **Step 4: 툴 노드에 "후보" 라벨을 적용한다**

`buildTree` 안 `children: rs.map((r): LensNode => {` 블록에서 `const toolDesc = ...` 줄을 교체:

```ts
          // 확신 낮은 삭제 권고는 확정이 아니라 후보 — 판정이 아니라 표시만 강등한다
          const { action, confidence } = r.recommendation;
          const actionLabel =
            confidence === 'low' && (action === 'remove' || action === 'filter-server')
              ? `${action}?(후보)` : action;
          const toolDesc = `${fmtCalls(r.callCount, r.reliability.errorCount)} · ${r.responseTokens}tok · ${actionLabel}`;
```

같은 블록의 반환 객체에서 `action: r.recommendation.action,` 줄을 교체 (위에서 구조 분해한 값을 그대로 쓴다):

```ts
            action,
            confidence,
```

- [ ] **Step 5: 아이콘 강조에서 low를 제외한다**

`packages/extension/src/lensTreeProvider.ts:34`를 교체:

```ts
      // 확신 낮은 권고는 아이콘으로 강조하지 않는다 (후보일 뿐 확정 아님)
      if (n.action && n.confidence !== 'low')
        item.iconPath = new vscode.ThemeIcon(ACTION_ICON[n.action] ?? 'circle-outline');
```

- [ ] **Step 6: 확장이 전 기간 호출 이력을 넘기게 한다**

`packages/extension/src/extension.ts`의 45-46행과 131-132행, 두 곳 모두 동일하게 교체:

```ts
      const input = { definitions: store!.allDefinitions(), calls: store!.callsSince(since),
        loads: store!.loadsSince(since), sessions: store!.sessionsSince(since),
        lastCallByTool: store!.lastCallByTool() };
```

(45행 쪽은 들여쓰기가 4칸, 131행 쪽은 6칸이다 — 각 위치의 기존 들여쓰기를 유지한다.)

- [ ] **Step 7: 테스트 통과를 확인한다**

Run: `npx vitest run packages/extension`
Expected: PASS

- [ ] **Step 8: 커밋**

```bash
git add packages/extension/src/matrixTree.ts packages/extension/src/lensTreeProvider.ts \
  packages/extension/src/extension.ts packages/extension/test/matrixTree.test.ts
git commit -m "feat(extension): 확신 낮은 권고를 후보 라벨로 표시"
```

---

### Task 6: 통합 확인 (동결 표면 무영향 검증)

**Files:**
- 수정 없음 — 검증 전용

- [ ] **Step 1: 전체 스위트**

Run: `npx vitest run`
Expected: PASS — core/cli/extension/dashboard 전부

- [ ] **Step 2: 전체 빌드**

Run: `npm run build`
Expected: 성공 — dashboard가 `src/` 한 줄도 수정되지 않은 채 새 계약으로 컴파일된다

- [ ] **Step 3: dashboard `src/`가 실제로 무수정인지 확인**

Run: `git diff --stat main -- packages/dashboard/src`
Expected: 출력 없음 (변경 0건)

- [ ] **Step 4: 커밋 (필요 시)**

검증만 했으므로 커밋할 것이 없다. `git status`가 깨끗한지만 확인한다.

---

## 스펙 미반영 항목 (의도적)

- **§7 비범위 그대로 유지**: 점수 모델, 새 action 값, 세션 빈도 예측, 대시보드 반영, 서버별 세션 귀속 정밀화 — 전부 구현하지 않는다.
- **알려진 한계 (문서화 대상)**: `startedAt`이 null인 세션은 관찰 창 판정이 불가해 무조건 포함된다. 과소평가를 막는 선택이지만, null 세션이 많은 클라이언트에서는 `observedSessions`가 실제보다 커질 수 있다.
