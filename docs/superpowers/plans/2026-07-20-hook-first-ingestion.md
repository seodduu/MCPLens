# Official Hook-First Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code, Codex, Gemini CLI의 공식 lifecycle Hook을 호출 사실의 1차 소스로 수집하고 기존 transcript 로그를 토큰·로드·백필 보강 소스로 병합한다.

**Architecture:** 각 클라이언트 Hook은 self-contained runner를 호출해 민감 본문을 제거한 `HookEnvelope`를 `~/.mcplens/inbox`에 원자 기록한다. 장기 실행 중인 extension 또는 CLI가 inbox를 drain해 단일 `LensStore` writer로 observation을 저장하고, transcript observation과 canonical call로 병합한다. `tools/list` 비용 축과 기존 분석 표면은 유지하되 수집 건강도가 낮으면 제거 권고를 강등한다.

**Tech Stack:** TypeScript strict, Node.js ≥20, npm workspaces, vitest, sql.js, chokidar, Claude Code plugins, Codex plugins, Gemini CLI extensions.

## Global Constraints

- `packages/core`에서 `vscode`를 import하지 않는다.
- DB 경로는 `os.homedir()`와 `path.join()`으로 만든 `~/.mcplens/lens.db`다.
- Hook 프로세스는 DB와 네트워크를 열지 않고 2초 이내, 정상 경로 p95 250ms 이내 종료한다.
- Hook stdout에는 클라이언트가 요구하는 정상 JSON만 출력하고 차단 결정을 반환하지 않는다.
- `tool_input`, `tool_response`, 프롬프트 본문은 Inbox와 DB에 저장하지 않는다.
- transcript는 `realpath` 후 해당 client log root 내부의 일반 파일일 때만 읽는다.
- 원본 로그는 읽기 전용이며 파싱 실패는 throw하지 않고 health receipt에 기록한다.
- 유닛 테스트는 fixture, 임시 디렉토리, `:memory:` DB만 사용한다.
- 공유 `types.ts`, `schema.sql`, `index.ts`, `store.ts`, `main.ts`, `extension.ts`는 지정된 통합 Task만 수정한다.
- 새 dependency와 네이티브 애드온을 추가하지 않는다.

---

## File Map

```text
packages/core/src/ingest/
  contracts.ts                 # H0: source-independent contracts
  identity.ts                  # H0: delivery/correlation IDs
  inbox.ts                     # H1: atomic queue
  coordinator.ts               # H5: drain + targeted reconciliation
  drainer.ts                   # H5: pending claim/commit lifecycle
  log-bridge.ts                # H6: AdapterResult → observations
  clients/claude/decoder.ts    # H2
  clients/codex/decoder.ts     # H3
  clients/gemini/decoder.ts    # H4
packages/core/src/health/
  collectionHealth.ts          # H7: state machine
packages/core/src/engine/
  healthGate.ts                # H7: recommendation gating
packages/core/src/store/
  observations.ts              # H8: observation queries/materializer
  schema.sql, store.ts         # H0/H8 shared integration
packages/cli/src/
  hook-capture.ts              # H5: private hook entry
  hooks-status.ts              # H10
  hooks-doctor.ts              # H10
packages/extension/src/
  hookStatus.ts                # H9
  hookStatusProvider.ts        # H9
packages/lens-audit-plugin/    # H2/H11 Claude package
packages/codex-plugin/         # H3/H11 Codex package
packages/gemini-extension/     # H4/H11 Gemini package
fixtures/hooks/{claude,codex,gemini}/
```

## Terminal Schedule

| Wave | Terminal | Tasks | Rule |
|---|---|---|---|
| 0 | T1 only | H0 | contract commit를 main에 먼저 merge |
| 1 | T1/T2/T3/T4 | H1 / H2 / H3 / H4 | 파일 소유권 완전 분리 |
| 2 | T1/T2/T3/T4 | H5 / H6 / H7 / H11 | H0 public API만 소비 |
| 3 | T1/T2/T3 | H8 / H9 / H10 | H9/H10은 H0 mock 사용, H8 merge 후 재검증 |
| 4 | T1 only | H12 | 실제 DB·실클라이언트 직렬 |

각 Task는 fresh implementation subagent → spec reviewer → quality reviewer 순서로 게이트한다.

---

### Task H0: Shared Observation Contract and Schema Migration

**Files:**
- Create: `packages/core/src/ingest/contracts.ts`
- Create: `packages/core/src/ingest/identity.ts`
- Create: `packages/core/test/ingest/contracts.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/store/schema.sql`
- Modify: `packages/core/src/store/store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `HookEnvelope`, `ToolObservation`, `CollectionHealth`, `makeDeliveryId()`, `makeCorrelationKey()`.
- Produces: `HookDecoder` and `HookNormalizationResult` so H2-H5 use one decoder registry.
- Produces DB tables: `ingest_observations`, `session_aliases`, `collector_receipts`.
- Compatibility: existing `AdapterResult`, `ToolCallEvent`, `AccountingMode` remain exported.

- [ ] **Step 1: Write contract and migration tests**

```ts
import { describe, expect, it } from 'vitest';
import { makeCorrelationKey, makeDeliveryId } from '../../src/ingest/identity.js';
import { LensStore } from '../../src/store/store.js';

describe('hook observation contract', () => {
  it('stable native ids produce stable delivery and correlation ids', () => {
    const base = { client: 'codex' as const, externalSessionId: 's1',
      externalTurnId: 't1', externalCallId: 'c1', phase: 'tool-after' as const,
      toolName: 'mcp__github__get_issue', inputFingerprint: null };
    expect(makeDeliveryId(base)).toBe(makeDeliveryId(base));
    expect(makeCorrelationKey(base)).toMatch(/^native:/);
  });

  it('opens an existing database and creates observation tables', async () => {
    const store = await LensStore.open(':memory:');
    expect(store.observationCount()).toBe(0);
    store.close();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx vitest run packages/core/test/ingest/contracts.test.ts`

Expected: FAIL because `ingest/contracts.js`, identity helpers, and `observationCount()` do not exist.

- [ ] **Step 3: Add the exact shared contracts**

```ts
// packages/core/src/ingest/contracts.ts
import type { ClientId } from '../types.js';

export type ObservationSource = 'hook' | 'log' | 'proxy';
export type HookPhase = 'session-start' | 'tool-before' | 'tool-after' |
  'tool-failure' | 'turn-stop' | 'session-end';
export type CorrelationConfidence = 'high' | 'medium' | 'low';
export type CollectionHealth = 'idle' | 'healthy' | 'hook-only' | 'log-only' |
  'degraded' | 'unavailable';

export interface HookEnvelope {
  schemaVersion: 1;
  deliveryId: string;
  client: ClientId;
  phase: HookPhase;
  receivedAt: string;
  externalSessionId: string;
  externalTurnId: string | null;
  externalCallId: string | null;
  transcriptPath: string | null;
  serverName: string | null;
  toolName: string | null;
  observedAt: string;
  durationMs: number | null;
  isError: boolean | null;
  inputFingerprint: string | null;
}

export interface ToolObservation extends HookEnvelope {
  source: ObservationSource;
  correlationKey: string;
  correlationConfidence: CorrelationConfidence;
  responseTokens: number | null;
  loadedTokens: number | null;
}

export type HookDecoder =
  (input: unknown, receivedAt: string) => HookNormalizationResult;

export type HookNormalizationResult =
  | { kind: 'observation'; observation: ToolObservation }
  | { kind: 'ignored'; reason: 'non-mcp-tool' | 'unsupported-phase' }
  | { kind: 'invalid'; code: 'invalid-json' | 'missing-field' | 'unsafe-transcript-path' };
```

In the same H0 commit, add `externalCallId: string | null` to `ToolCallEvent`. H6 adapters populate it; no later parallel Task may edit `types.ts` for this field.

Implement `identity.ts` with SHA-256 over ordered JSON keys. Native call IDs must return `native:<hash>`; fallback must return `fallback:<hash>` and never contain raw input.

- [ ] **Step 4: Add idempotent SQL migration**

Add these tables to `schema.sql`, and mirror `tool_definitions.first_scanned_at` style `PRAGMA table_info` migration in `store.ts`:

```sql
CREATE TABLE IF NOT EXISTS ingest_observations (
  observation_id TEXT PRIMARY KEY,
  correlation_key TEXT NOT NULL,
  correlation_confidence TEXT NOT NULL,
  source TEXT NOT NULL,
  client TEXT NOT NULL,
  phase TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  external_turn_id TEXT,
  external_call_id TEXT,
  transcript_path TEXT,
  server_name TEXT,
  tool_name TEXT,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  duration_ms INTEGER,
  is_error INTEGER,
  response_tokens INTEGER,
  loaded_tokens INTEGER,
  input_fingerprint TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_delivery
  ON ingest_observations(observation_id);
CREATE INDEX IF NOT EXISTS idx_observation_correlation
  ON ingest_observations(correlation_key);
CREATE TABLE IF NOT EXISTS session_aliases (
  client TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  transcript_path TEXT,
  PRIMARY KEY(client, external_session_id)
);
CREATE TABLE IF NOT EXISTS collector_receipts (
  receipt_id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  error_code TEXT
);
```

In the same migration, change the existing session contract without losing legacy rows:

```sql
-- migration v2: copy because SQLite cannot directly drop NOT NULL
CREATE TABLE sessions_v2 (
  session_id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  file_path TEXT,
  external_session_id TEXT,
  started_at TEXT,
  mode TEXT NOT NULL DEFAULT 'DEFERRED_OPAQUE'
);
INSERT INTO sessions_v2(session_id, client, file_path, started_at, mode)
  SELECT session_id, client, file_path, started_at, mode FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;
```

Change `SessionMeta.filePath` to `string | null`, and add optional `externalCallId?: string | null` to `ToolCallEvent` plus optional `externalSessionId?: string | null` to `SessionMeta`; existing adapters keep returning their current values until H6 fills native IDs.

Add `observationCount(): number` using `SELECT COUNT(*) AS count FROM ingest_observations` and export the new contracts/helpers from `index.ts`.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run packages/core/test/ingest/contracts.test.ts packages/core/test/store/store.test.ts`

Expected: both files PASS and existing DB migration tests remain green.

```bash
git add packages/core/src/ingest packages/core/src/types.ts packages/core/src/store packages/core/src/index.ts packages/core/test/ingest
git commit -m "feat(core): add hook observation contract"
```

---

### Task H1: Durable Atomic Inbox

**Files:**
- Create: `packages/core/src/ingest/inbox.ts`
- Create: `packages/core/test/ingest/inbox.test.ts`
- Modify: `packages/core/src/paths.ts`

**Interfaces:**
- Consumes: `HookEnvelope` from H0.
- Produces: `inboxPaths()`, `enqueueEnvelope()`, `claimPending()`, `markProcessed()`, `releaseClaim()`.

- [ ] **Step 1: Write concurrency and privacy tests**

```ts
it('atomically enqueues one redacted event per delivery id', () => {
  const root = mkdtempSync(join(tmpdir(), 'lens-inbox-'));
  const env = fixtureEnvelope({ deliveryId: 'd1' });
  enqueueEnvelope(env, { root });
  enqueueEnvelope(env, { root });
  expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
  expect(readFileSync(join(root, 'pending/d1.json'), 'utf8')).not.toContain('secret');
});
```

Also test 20 parallel enqueue calls, stale `.processing` recovery, 1MiB rejection, directory mode `0700`, file mode `0600`, and processed retention move.

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run packages/core/test/ingest/inbox.test.ts`

Expected: FAIL because inbox functions are missing.

- [ ] **Step 3: Implement file-per-event inbox**

```ts
export interface InboxOptions { root?: string; now?: () => Date; }
export function enqueueEnvelope(env: HookEnvelope, opts: InboxOptions = {}): 'queued' | 'duplicate';
export function claimPending(opts?: InboxOptions): ClaimedEnvelope[];
export function markProcessed(claim: ClaimedEnvelope, opts?: InboxOptions): void;
export function releaseClaim(claim: ClaimedEnvelope, opts?: InboxOptions): void;
```

Use `openSync(tmp, 'wx', 0o600)`, `writeFileSync`, `closeSync`, then `renameSync`. A duplicate final filename returns `duplicate`; partial temp files are never read. `claimPending` renames `.json` to `.processing` before reading.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/ingest/inbox.test.ts packages/core/test/paths.test.ts`

Expected: PASS.

```bash
git add packages/core/src/ingest/inbox.ts packages/core/src/paths.ts packages/core/test/ingest/inbox.test.ts
git commit -m "feat(core): add durable hook inbox"
```

---

### Task H2: Claude Hook Decoder and Plugin Assets

**Files:**
- Create: `packages/core/src/ingest/clients/claude/decoder.ts`
- Create: `packages/core/test/ingest/clients/claude.test.ts`
- Create: `fixtures/hooks/claude/session-start.json`
- Create: `fixtures/hooks/claude/post-tool-use.json`
- Create: `fixtures/hooks/claude/post-tool-failure.json`
- Create: `packages/lens-audit-plugin/hooks/hooks.json`

**Interfaces:**
- Produces: `decodeClaudeHook(input: unknown, receivedAt: string): HookEnvelope | null`.
- Built-in tools return `null`; MCP names use `mcp__server__tool`.

- [ ] **Step 1: Add anonymized official payload fixtures and failing decoder tests**

```ts
expect(decodeClaudeHook(fixture('post-tool-use.json'), NOW)).toMatchObject({
  client: 'claude-code', phase: 'tool-after', externalSessionId: 'session-claude-1',
  externalCallId: 'toolu_01', serverName: 'github', toolName: 'get_issue', isError: false,
});
expect(decodeClaudeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, NOW)).toBeNull();
```

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run packages/core/test/ingest/clients/claude.test.ts`

Expected: FAIL because decoder is missing.

- [ ] **Step 3: Implement tolerant field extraction**

Accept common fields `session_id`, `transcript_path`, `hook_event_name`, `tool_name`, `tool_use_id`, `duration_ms`. Map `PostToolUseFailure` to `tool-failure`; discard `tool_input` and `tool_response`; return null when session ID or eligible MCP tool name is absent.

- [ ] **Step 4: Add plugin hook registration**

Register `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd` in `hooks/hooks.json`. Use `${CLAUDE_PLUGIN_ROOT}` and a bundled runner path; matcher is `^mcp__.*` for tool hooks. Runner stdout must be `{}`.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run packages/core/test/ingest/clients/claude.test.ts`

Expected: PASS; `rg -n "tool_input|tool_response" fixtures/hooks/claude` may find fixture keys but test asserts decoded JSON does not retain values.

```bash
git add packages/core/src/ingest/clients/claude packages/core/test/ingest/clients/claude.test.ts fixtures/hooks/claude packages/lens-audit-plugin/hooks
git commit -m "feat: add Claude hook ingestion adapter"
```

---

### Task H3: Codex Hook Decoder and Plugin Assets

**Files:**
- Create: `packages/core/src/ingest/clients/codex/decoder.ts`
- Create: `packages/core/test/ingest/clients/codex.test.ts`
- Create: `fixtures/hooks/codex/session-start.json`
- Create: `fixtures/hooks/codex/post-tool-use.json`
- Create: `packages/codex-plugin/.codex-plugin/plugin.json`
- Create: `packages/codex-plugin/hooks/hooks.json`
- Create: `packages/codex-plugin/README.md`

**Interfaces:**
- Produces: `decodeCodexHook(input: unknown, receivedAt: string): HookEnvelope | null`.
- Requires exact MCP name matching `mcp__<server>__<tool>`; `transcript_path` may be null.

- [ ] **Step 1: Write fixture contract tests**

Test `session_id`, `turn_id`, nullable `transcript_path`, `hook_event_name`, `tool_name`, call ID when present, model field tolerance, unknown fields, and hosted/non-MCP tool rejection.

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run packages/core/test/ingest/clients/codex.test.ts`

Expected: FAIL because decoder is missing.

- [ ] **Step 3: Implement decoder and plugin hooks**

Map `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`; only `PostToolUse` creates completed-call evidence. Add plugin manifest and document that non-managed hooks require `/hooks` hash trust before they run.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/ingest/clients/codex.test.ts`

Expected: PASS.

```bash
git add packages/core/src/ingest/clients/codex packages/core/test/ingest/clients/codex.test.ts fixtures/hooks/codex packages/codex-plugin
git commit -m "feat: add Codex hook ingestion adapter"
```

---

### Task H4: Gemini Hook Decoder and Extension Assets

**Files:**
- Create: `packages/core/src/ingest/clients/gemini/decoder.ts`
- Create: `packages/core/test/ingest/clients/gemini.test.ts`
- Create: `fixtures/hooks/gemini/session-start.json`
- Create: `fixtures/hooks/gemini/after-tool.json`
- Create: `packages/gemini-extension/gemini-extension.json`
- Create: `packages/gemini-extension/hooks/hooks.json`
- Create: `packages/gemini-extension/README.md`

**Interfaces:**
- Produces: `decodeGeminiHook(input: unknown, receivedAt: string): HookEnvelope | null`.
- Uses `mcp_context` when present and falls back to existing `splitFlattenedName()` rules.

- [ ] **Step 1: Write fixture contract tests**

Test common `session_id`, `transcript_path`, `timestamp`, `BeforeTool`, `AfterTool`, `tool_name`, `tool_response.error`, `mcp_context`, built-in rejection, and stdout-silence contract.

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run packages/core/test/ingest/clients/gemini.test.ts`

Expected: FAIL because decoder is missing.

- [ ] **Step 3: Implement decoder and extension hooks**

Register `SessionStart`, `BeforeTool`, `AfterTool`, `SessionEnd`. Every command hook returns `{}` on stdout; diagnostics go to stderr. Do not persist `tool_input`, `llmContent`, or `returnDisplay`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/ingest/clients/gemini.test.ts`

Expected: PASS.

```bash
git add packages/core/src/ingest/clients/gemini packages/core/test/ingest/clients/gemini.test.ts fixtures/hooks/gemini packages/gemini-extension
git commit -m "feat: add Gemini hook ingestion adapter"
```

---

### Task H5: Capture CLI, Inbox Drainer, and Coordinator

**Files:**
- Create: `packages/cli/src/hook-capture.ts`
- Create: `packages/cli/test/hook-capture.test.ts`
- Create: `packages/core/src/ingest/drainer.ts`
- Create: `packages/core/src/ingest/coordinator.ts`
- Create: `packages/core/test/ingest/coordinator.test.ts`

**Interfaces:**
- Produces: `captureHook(client, stdin, now): CaptureResult`.
- Produces: `IngestionCoordinator.drainInbox()` and `reconcilePath(path, trigger)`.
- Constraint: CLI capture never opens `LensStore`.

- [ ] **Step 1: Write fail-open capture tests**

```ts
expect(captureHook('gemini-cli', malformed, NOW, deps)).toEqual({ stdout: '{}\n', exitCode: 0 });
expect(deps.openStore).not.toHaveBeenCalled();
```

Test valid payload queueing, >1MiB rejection, decoder failure receipt without raw payload, and all client stdout contracts.

- [ ] **Step 2: Write coordinator crash-recovery tests**

Given two pending events, make store insertion fail on the second. Assert the first moves to processed, the second returns to pending, and a retry materializes exactly once.

- [ ] **Step 3: Implement capture dispatch and coordinator**

Decoder registry is an exact `Record<ClientId, HookDecoder>`. `drainInbox()` claims one file, decodes/upserts through injected store callbacks, marks processed only after commit, and emits `ingested` once per batch.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/cli/test/hook-capture.test.ts packages/core/test/ingest/coordinator.test.ts`

Expected: PASS.

```bash
git add packages/cli/src/hook-capture.ts packages/cli/test/hook-capture.test.ts packages/core/src/ingest/drainer.ts packages/core/src/ingest/coordinator.ts packages/core/test/ingest/coordinator.test.ts
git commit -m "feat: add hook capture coordinator"
```

---

### Task H6: Transcript Observation Bridge and Targeted Reconciliation

**Files:**
- Create: `packages/core/src/ingest/log-bridge.ts`
- Create: `packages/core/test/ingest/log-bridge.test.ts`
- Modify: `packages/core/src/watch/watcher.ts`
- Modify: `packages/core/src/adapters/claude/adapter.ts`
- Modify: `packages/core/src/adapters/codex/adapter.ts`
- Modify: `packages/core/src/adapters/gemini/adapter.ts`

**Interfaces:**
- Produces: `adapterResultToObservations(result, nativeIds): ToolObservation[]`.
- Produces public `LogWatcher.reconcilePath(filePath, trigger)`.
- Existing `backfill()` and `start()` remain compatible.

- [ ] **Step 1: Add native ID preservation tests to all adapters**

Assert the H0 `ToolCallEvent.externalCallId` field is populated from Claude `tool_use.id`, Codex call ID, and Gemini tool call ID.

- [ ] **Step 2: Add path safety and debounce tests**

Assert a Hook transcript path outside `clientLogRoots(client)` is rejected, three rapid reconcile requests parse once, and transcript lag retries at injected 250ms/1s/3s schedule.

- [ ] **Step 3: Implement bridge and watcher API**

`reconcilePath` resolves the owning adapter, validates `realpath`, reuses cursor logic, and records trigger/parseErrors receipts. Chokidar and Hook requests share one per-path debounce map. Native IDs are added to the existing optional `ToolCallEvent.externalCallId` field; H6 does not edit shared contract files.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/adapters packages/core/test/watch/watcher.test.ts packages/core/test/ingest/log-bridge.test.ts`

Expected: PASS.

```bash
git add packages/core/src/ingest/log-bridge.ts packages/core/src/watch/watcher.ts packages/core/src/adapters/claude/adapter.ts packages/core/src/adapters/codex/adapter.ts packages/core/src/adapters/gemini/adapter.ts packages/core/test/ingest/log-bridge.test.ts packages/core/test/watch/watcher.test.ts packages/core/test/adapters/claude/adapter.test.ts packages/core/test/adapters/codex/adapter.test.ts packages/core/test/adapters/gemini/adapter.test.ts
git commit -m "feat(core): reconcile hook and transcript observations"
```

---

### Task H7: Collection Health and Recommendation Gate

**Files:**
- Create: `packages/core/src/health/collectionHealth.ts`
- Create: `packages/core/src/engine/healthGate.ts`
- Create: `packages/core/test/health/collectionHealth.test.ts`
- Create: `packages/core/test/engine/healthGate.test.ts`

**Interfaces:**
- Produces: `deriveCollectionHealth(input): CollectionHealthSnapshot`.
- Produces: `gateRecommendation(recommendation, health): Recommendation`.

- [ ] **Step 1: Write fake-clock state tests**

Test idle is not degraded, one miss stays healthy, three correlated misses become degraded, two matches recover healthy, hook-only/log-only detection, and SessionEnd absence alone has no effect.

- [ ] **Step 2: Write gate tests**

Assert `remove` and `filter-server` become low-confidence candidates under degraded/unavailable health, while `inspect` based on observed failures remains visible and tokens become `측정 불가` under hook-only.

- [ ] **Step 3: Implement pure state and gate functions**

Use constants `CORRELATION_GRACE_MS=10_000`, `MISSES_TO_DEGRADE=3`, `MATCHES_TO_RECOVER=2`. No filesystem, DB, or VS Code imports.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/health packages/core/test/engine`

Expected: PASS.

```bash
git add packages/core/src/health packages/core/src/engine/healthGate.ts packages/core/test/health packages/core/test/engine/healthGate.test.ts
git commit -m "feat(core): gate recommendations by collection health"
```

---

### Task H8: Observation Store, Canonical Materializer, and Existing Data Migration

**Files:**
- Create: `packages/core/src/store/observations.ts`
- Create: `packages/core/test/store/observations.test.ts`
- Modify: `packages/core/src/store/store.ts`
- Modify: `packages/core/src/store/schema.sql`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `LensStore.upsertObservation()`, `observationsForSession()`, `recordReceipt()`, `collectionHealth()`.
- Produces: `materializeSession(observations): AdapterResult`.
- Existing `ingest(AdapterResult)` remains for migration compatibility but delegates to log observations.

- [ ] **Step 1: Write order-independent merge tests**

Assert Hook→log and log→Hook yield identical canonical calls; duplicate deliveries remain one call; transcript reparse does not remove Hook error/duration; response tokens prefer client-reported log value; legacy DB opens without data loss.

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run packages/core/test/store/observations.test.ts`

Expected: FAIL because observation APIs do not exist.

- [ ] **Step 3: Implement field-level materialization**

Group by `correlationKey`. A group becomes a call only when it contains `tool-after`, `tool-failure`, or a legacy completed log call. Precedence is Hook identity/error/duration, then log response/load/token data. Rebuild only the affected canonical session inside one transaction.

- [ ] **Step 4: Verify migration and regression**

Run: `npx vitest run packages/core/test/store packages/core/test/e2e/pipeline.test.ts`

Expected: PASS; existing fixture counts unchanged in log-only mode.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store packages/core/src/index.ts packages/core/test/store
git commit -m "feat(core): materialize canonical calls from observations"
```

---

### Task H9: VS Code Collection Health Surface

**Files:**
- Create: `packages/extension/src/hookStatus.ts`
- Create: `packages/extension/src/hookStatusProvider.ts`
- Create: `packages/extension/test/hookStatus.test.ts`
- Modify: `packages/extension/src/extension.ts`
- Modify: `packages/extension/package.json`

**Interfaces:**
- Consumes: public core health snapshot and coordinator.
- Produces view `mcpLens.collection` and commands `mcp-lens.hooksDoctor`, `mcp-lens.hooksPause`.

- [ ] **Step 1: Write pure presentation tests**

Assert healthy, hook-only, log-only, waiting-first-event, review-required, degraded, and idle labels. No VS Code API in the formatter test.

- [ ] **Step 2: Add collection view manifest**

Register a second TreeDataProvider under the existing `mcpLens` container. Keep matrix tree files unchanged.

- [ ] **Step 3: Wire lifecycle in extension**

Activation order is: open store → drain pending → backfill → refresh → subscribe coordinator/watcher → start live watcher. Refresh both matrix and collection views on observation, receipt, config, and report-days events.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/extension/test/hookStatus.test.ts && npm run typecheck -w mcp-lens && npm run build -w mcp-lens`

Expected: PASS and extension bundle builds.

```bash
git add packages/extension/src/hookStatus.ts packages/extension/src/hookStatusProvider.ts packages/extension/test/hookStatus.test.ts packages/extension/src/extension.ts packages/extension/package.json
git commit -m "feat(extension): show hook collection health"
```

---

### Task H10: CLI Hook Status and Doctor

**Files:**
- Create: `packages/cli/src/hooks-status.ts`
- Create: `packages/cli/src/hooks-doctor.ts`
- Create: `packages/cli/test/hooks-status.test.ts`
- Create: `packages/cli/test/hooks-doctor.test.ts`
- Modify: `packages/cli/src/main.ts`

**Interfaces:**
- Commands: `mcp-lens hooks status [--json]`, `mcp-lens hooks doctor [client]`.
- Private command: `mcp-lens hook capture --client <id>`.

- [ ] **Step 1: Write stable JSON and layered doctor tests**

The JSON contract contains client, package state, trust state, runner state, last event, pending count, fallback state, and health. Doctor must distinguish warning from failure and never claim Codex trust is approved when it cannot read trust state.

- [ ] **Step 2: Add command dispatch without changing report/scan/auth behavior**

Unknown-command help becomes `report|scan|auth|hooks|hook`. Capture reads stdin once, writes only its required stdout, and routes diagnostics to stderr.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run packages/cli/test && npm run build -w @mcp-lens/cli`

Expected: PASS.

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(cli): add hook status and doctor commands"
```

---

### Task H11: Self-Contained Three-Client Packaging

**Files:**
- Modify: `packages/lens-audit-plugin/.claude-plugin/plugin.json`
- Modify: `packages/lens-audit-plugin/README.md`
- Create: `packages/lens-audit-plugin/scripts/hook-runner.mjs`
- Modify: `packages/codex-plugin/.codex-plugin/plugin.json`
- Create: `packages/codex-plugin/scripts/hook-runner.mjs`
- Modify: `packages/codex-plugin/README.md`
- Modify: `packages/gemini-extension/gemini-extension.json`
- Create: `packages/gemini-extension/scripts/hook-runner.mjs`
- Create: `packages/hook-runtime/hook-capture.mjs`
- Create: `packages/hook-runtime/scripts/sync-runtime.mjs`
- Modify: `packages/gemini-extension/README.md`
- Create: `scripts/verify-hook-packages.mjs`

**Interfaces:**
- Every package invokes its bundled runner, not `npx` or a versioned VS Code extension path.
- Runner only decodes/redacts/enqueues and prints `{}`.
- `sync-runtime.mjs` copies the dependency-free compiled subset of `contracts`, `identity`, `inbox`, and the three decoders plus `hook-capture.mjs` into each package's `runtime/` directory. It does not copy `@mcp-lens/core` as a package or any DB/scanner modules.

- [ ] **Step 1: Write package verification script**

The script first verifies every copied runtime file is byte-identical to the canonical source/compiled file, then loads all manifests/hook JSON, resolves runner paths, spawns each runner with one fixture, and asserts exit 0/stdout `{}`/one pending file/no secret content.

- [ ] **Step 2: Bundle runtime and document trust/restart behavior**

Claude documents plugin reload/new session, Codex documents `/hooks` trust, Gemini documents CLI restart. All three document local-only storage and disable/uninstall behavior.

- [ ] **Step 3: Verify and commit**

Run: `node scripts/verify-hook-packages.mjs`

Expected: three clients PASS.

```bash
git add packages/hook-runtime packages/lens-audit-plugin packages/codex-plugin packages/gemini-extension scripts/verify-hook-packages.mjs
git commit -m "feat: package hook runners for three clients"
```

---

### Task H12: Hook Pipeline E2E, Shadow Rollout, and Real-Client Smoke

**Files:**
- Create: `packages/core/test/e2e/hook-pipeline.test.ts`
- Create: `packages/core/test/e2e/hook-health.test.ts`
- Modify: `docs/SMOKE.md`
- Modify: `docs/system-flow.md`
- Modify: `MCP-Lens-설계문서-v2.md`

**Interfaces:**
- Validates the completed H0-H11 system; introduces no new product API.

- [ ] **Step 1: Add deterministic fixture E2E**

Cover Hook-only, log-only, Hook→log, log→Hook, corrupt log with healthy Hook, inbox restart, and three-client combined matrix. Assert one logical call per native call ID.

- [ ] **Step 2: Add rollout feature flags**

Use exact states `shadow`, `count-primary`, `health-gated`. Default released state is `shadow`; tests prove shadow does not alter existing recommendation results.

- [ ] **Step 3: Run repository verification**

Run: `npm test`

Expected: all unit and E2E tests PASS.

Run: `npm run build`

Expected: all workspaces build.

Run: `npm run typecheck -w mcp-lens && npm run smoke -w mcp-lens`

Expected: extension typecheck and bundle smoke PASS.

- [ ] **Step 4: Run real clients serially**

For each client, use one dummy stdio server with `echo` and `fail` tools. Verify package installed, hook trusted/enabled, success and failure receipts, transcript enrichment, canonical count 2, and log corruption transition. Do not run clients or shared DB in parallel.

- [ ] **Step 5: Commit verification docs**

```bash
git add packages/core/test/e2e docs/SMOKE.md docs/system-flow.md MCP-Lens-설계문서-v2.md
git commit -m "test: verify hook-first ingestion pipeline"
```

---

## Wave Merge Gates

At each wave boundary the integration terminal runs:

```bash
git diff --check
npm test
npm run build
git status --short
```

Reject a branch if it edits another Task's files, stores raw tool input/output, opens DB in a Hook runner, introduces a blocking Hook response, or uses the real shared DB in unit tests.

## Definition of Done

- All H0-H12 tasks are merged in dependency order.
- Claude, Codex, Gemini packages emit official Hook receipts.
- Hook-only call counts survive broken transcript formats.
- Log-only behavior remains compatible with the current release.
- Hook+log duplicate calls materialize once.
- Collection health gates destructive recommendations.
- Inbox crash recovery and single-writer guarantees are tested.
- Full tests/build/typecheck/smoke and three-client serial smoke pass.
