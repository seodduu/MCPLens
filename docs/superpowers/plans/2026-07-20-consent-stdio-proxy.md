# Consent-Based STDIO Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 서버별로 명시 동의한 Claude Code, Codex, Gemini CLI의 stdio MCP 서버만 MCP Lens Proxy로 안전하게 wrapping하고, 새 서버 등록 시 한 번 질문하며, 검증 실패·해제 시 원본 설정을 복구한다.

**Architecture:** Proxy manager는 설정 파일을 직접 소유하지 않고 원본 정의/hash와 사용자 결정을 별도 registry에 기록한다. 클라이언트별 config transformer는 stdio 서버의 command/args만 stable Proxy runner로 바꾸고 나머지 필드를 보존하며, 실제 Proxy runtime은 JSON-RPC bytes를 변경 없이 중계하고 메타데이터 observation만 Hook inbox에 기록한다. HTTP/SSE transport는 이번 계획에서 읽기 전용 `unsupported` 상태다.

**Tech Stack:** TypeScript strict, Node.js ≥20, npm workspaces, vitest, Node child_process/streams, smol-toml, VS Code Extension API, existing atomic file utilities.

## Prerequisite

`2026-07-20-hook-first-ingestion.md`의 H0-H12가 merge되고 `ToolObservation`, Inbox, observation store, health gate가 공개 API로 존재해야 한다. P7과 P8은 이 계약 없이는 시작하지 않는다.

## Global Constraints

- VS Code 확장 설치만으로 MCP 설정을 변경하지 않는다.
- `ProxyPromptPolicy`는 `ask-new | never`뿐이며 새 서버 자동 wrapping은 제공하지 않는다.
- 모든 설정 변경은 서버별 사용자 승인 후 수행한다.
- v1은 stdio transport만 수정하며 HTTP/SSE/Streamable HTTP는 건너뛴다.
- Proxy는 JSON-RPC stdin/stdout bytes와 순서를 변경하지 않는다.
- 요청 인자, 응답 본문, 인증정보는 저장하지 않는다.
- 설정 변경 전 원본 정의/hash를 기록하고 temp→parse validation→atomic rename을 사용한다.
- 현재 설정이 `installedHash`와 다르면 자동 disable/repair하지 않고 `drifted`로 보고한다.
- managed/system 설정과 VS Code Web 환경은 수정하지 않는다.
- 프로젝트 설정은 Git 공유 가능성을 modal warning으로 재확인한다.
- unit test는 fixture·temp dir·dummy stdio process만 사용한다.

---

## File Map

```text
packages/core/src/proxy/
  contracts.ts                 # P0
  identity.ts                  # P0
  registry.ts                  # P0
  install.ts                   # P0 stable runner installation
  config/common.ts             # P0 mutation transaction
  config/claude.ts             # P2
  config/codex.ts              # P3
  config/gemini.ts             # P4
  observation.ts               # P7
packages/proxy/
  package.json                 # P1
  src/main.ts                  # P1 byte relay
  src/observe.ts               # P1 JSON-RPC metadata
  test/relay.test.ts           # P1
packages/extension/src/
  proxyConsent.ts              # P5 pure decisions
  proxyManager.ts              # P5 orchestration
  proxyStatus.ts               # P5 presentation
packages/cli/src/
  proxy-command.ts             # P6
  proxy-format.ts              # P6
fixtures/proxy/{claude,codex,gemini}/
```

## Terminal Schedule

| Wave | Terminals | Tasks | Gate |
|---|---:|---|---|
| 5 | 1 | P0 | registry/config transaction contract merge |
| 6 | 4 | P1 / P2 / P3 / P4 | runtime and three client transforms isolated |
| 7 | 3 | P5 / P6 / P7 | extension, CLI, observations isolated |
| 8 | 1 | P8 | shared DB and real clients serial |

---

### Task P0: Proxy Contracts, Identity, Registry, and Atomic Mutation

**Files:**
- Create: `packages/core/src/proxy/contracts.ts`
- Create: `packages/core/src/proxy/identity.ts`
- Create: `packages/core/src/proxy/registry.ts`
- Create: `packages/core/src/proxy/install.ts`
- Create: `packages/core/src/proxy/config/common.ts`
- Create: `packages/core/test/proxy/registry.test.ts`
- Create: `packages/core/test/proxy/common.test.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ProxyPromptPolicy`, `ProxyRegistration`, `ProxyCandidate`, `ProxyMutation`.
- Produces: `serverIdentity()`, `readProxyRegistry()`, `writeProxyRegistry()`, `applyMutation()`, `restoreMutation()`.

- [ ] **Step 1: Write registry and drift tests**

```ts
it('does not restore over a user-edited config', () => {
  const reg = enabledRegistration({ installedHash: sha256(installedText) });
  writeFileSync(configPath, userEditedText);
  expect(restoreMutation(reg)).toEqual({ kind: 'drifted' });
  expect(readFileSync(configPath, 'utf8')).toBe(userEditedText);
});
```

Test default `ask-new`, enabled/deferred/declined/drifted round-trip, identity stability, atomic registry write, mode `0600`, and no plaintext environment values in identity.

- [ ] **Step 2: Confirm failure**

Run: `npx vitest run packages/core/test/proxy/registry.test.ts packages/core/test/proxy/common.test.ts`

Expected: FAIL because proxy APIs are missing.

- [ ] **Step 3: Add exact contracts**

```ts
export type ProxyPromptPolicy = 'ask-new' | 'never';
export type ProxyDecision = 'enabled' | 'deferred' | 'declined' | 'drifted';
export type ProxyScope = 'user' | 'project' | 'local' | 'managed';
export type ProxyConfigLocator =
  | { kind: 'json-pointer'; segments: string[] }
  | { kind: 'toml-table'; segments: ['mcp_servers', string] };

export interface ProxyCandidate {
  serverIdentity: string;
  client: ClientId;
  configPath: string;
  configScope: ProxyScope;
  configLocator: ProxyConfigLocator;
  serverName: string;
  transport: 'stdio' | 'http' | 'unknown';
  command: string | null;
  args: string[];
  editable: boolean;
}

export interface ProxyRegistration {
  serverIdentity: string;
  client: ClientId;
  configPath: string;
  configScope: ProxyScope;
  configLocator: ProxyConfigLocator;
  serverName: string;
  transport: 'stdio';
  decision: ProxyDecision;
  originalDefinition: unknown;
  originalFileHash: string;
  originalHash: string;
  installedHash: string | null;
  backupPath: string;
  operation: 'enabling' | 'disabling' | null;
  decidedAt: string;
  lastVerifiedAt: string | null;
}

export interface ProxyRunner {
  command: string;
  argsPrefix: string[];
  version: string;
}
```

- [ ] **Step 4: Implement mutation transaction**

`applyMutation` accepts original text, transformed text, and `validate(text)`. It verifies current hash, writes sibling temp mode `0600`, validates the temp contents, renames, re-reads, and returns installed hash. On any failure it leaves the original bytes unchanged. `restoreMutation` only restores when current hash equals `installedHash`.

- [ ] **Step 5: Implement stable runner installation**

Install the bundled runner under the stable `~/.mcplens/bin/` path using temp/checksum/rename. On POSIX, install executable `mcp-lens-proxy` with a Node shebang and mode `0755`. On Windows, install `mcp-lens-proxy.mjs`, resolve an absolute Node ≥20 `node.exe`, and expose `RunnerCommand { command, argsPrefix }`. Never use VS Code/Electron `process.execPath` unless it is a verified Node executable.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run packages/core/test/proxy/registry.test.ts packages/core/test/proxy/common.test.ts packages/core/test/paths.test.ts`

Expected: PASS.

```bash
git add packages/core/src/proxy packages/core/src/paths.ts packages/core/src/index.ts packages/core/test/proxy
git commit -m "feat(core): add consent proxy registry"
```

---

### Task P1: Transparent STDIO Proxy Runtime

**Files:**
- Create: `packages/proxy/package.json`
- Create: `packages/proxy/tsconfig.json`
- Create: `packages/proxy/src/main.ts`
- Create: `packages/proxy/src/observe.ts`
- Create: `packages/proxy/test/relay.test.ts`
- Create: `packages/proxy/test/fixtures/dummy-server.mjs`

**Interfaces:**
- Binary: `mcp-lens-proxy --client <id> --server <name> -- <command> [args...]`.
- Produces hook-inbox `ToolObservation` metadata for `tools/call` request/result pairs.

- [ ] **Step 1: Write byte transparency tests**

Spawn proxy around dummy server. Send initialize, tools/list, successful tools/call, failed tools/call, malformed non-JSON line, and cancellation. Assert client-visible stdout bytes equal direct dummy-server stdout bytes and stderr is forwarded.

- [ ] **Step 2: Write metadata privacy tests**

Assert observation contains server, tool, request ID correlation, started/completed timestamps, duration, error flag, and response byte count; it must not contain params, result, auth headers, or response text.

- [ ] **Step 3: Implement transparent relay**

Use `spawn(command, args, { stdio: ['pipe','pipe','pipe'], env: process.env })`. Pipe parent stdin bytes to child stdin and child stdout bytes to parent stdout immediately. Tee complete newline-delimited JSON-RPC frames to `observe.ts` without delaying forwarding. Forward signals and exit with the child exit code.

- [ ] **Step 4: Implement request/result correlation**

Track only request ID → `{toolName, startedAt}` for `tools/call`. On matching response compute duration/error/byte count and enqueue metadata. Ignore notifications and malformed frames without affecting relay.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run packages/proxy/test/relay.test.ts && npm run build -w @mcp-lens/proxy`

Expected: PASS and proxy workspace builds.

```bash
git add packages/proxy
git commit -m "feat(proxy): add transparent stdio relay"
```

---

### Task P2: Claude Configuration Transformer

**Files:**
- Create: `packages/core/src/proxy/config/claude.ts`
- Create: `packages/core/test/proxy/claude.test.ts`
- Create: `fixtures/proxy/claude/user.json`
- Create: `fixtures/proxy/claude/project.mcp.json`

**Interfaces:**
- Produces: `discoverClaudeProxyCandidates(paths): ProxyCandidate[]`.
- Produces: `wrapClaudeServer(text, target, runner): ProxyMutation`.
- Preserves local/project/user scope and every unknown server field.

- [ ] **Step 1: Write semantic preservation tests**

Fixtures include `env`, `cwd`, timeout, disabled metadata, unrelated settings, top-level and project servers, HTTP servers, and an already wrapped server. Assert only selected stdio command/args change, HTTP is unsupported, and wrapping twice is a no-op.

- [ ] **Step 2: Implement discovery without `collectAllSpecs()` dedupe**

Read every source with config path/scope intact. `serverIdentity` includes client, canonical config path, scope, server name, and original command/args fingerprint. Do not merge same-name servers from different scopes.

- [ ] **Step 3: Implement wrapping**

Replacement definition uses absolute Node command and args:

```ts
{
  ...original,
  command: runner.command,
  args: [...runner.argsPrefix, '--client', 'claude-code', '--server', name,
    '--', original.command, ...(original.args ?? [])],
}
```

Keep `env`, `cwd`, and unknown fields on the outer server so the proxy child inherits them.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/proxy/claude.test.ts`

Expected: PASS.

```bash
git add packages/core/src/proxy/config/claude.ts packages/core/test/proxy/claude.test.ts fixtures/proxy/claude
git commit -m "feat(core): wrap Claude stdio MCP configs"
```

---

### Task P3: Codex TOML Configuration Transformer

**Files:**
- Create: `packages/core/src/proxy/config/codex.ts`
- Create: `packages/core/test/proxy/codex.test.ts`
- Create: `fixtures/proxy/codex/config.toml`
- Create: `fixtures/proxy/codex/project-config.toml`

**Interfaces:**
- Produces: `discoverCodexProxyCandidates(text, source): ProxyCandidate[]`.
- Produces: `wrapCodexServer(text, target, runner): ProxyMutation`.
- Must preserve unrelated TOML text, comments, nested tool policies, cwd, env/env_vars, timeouts, required/enabled flags.

- [ ] **Step 1: Write byte-local mutation tests**

Fixture includes comments, quoted server names, `[mcp_servers.name.env]`, `[mcp_servers.name.tools.read]`, HTTP server, and two other top-level sections. Assert only the target table's `command` and `args` lines change and all other bytes compare equal.

- [ ] **Step 2: Implement table boundary discovery**

Parse with `smol-toml` for semantic validation, then locate the selected `[mcp_servers.<name>]` header and its direct command/args assignments in source text. Replace or insert only those assignments before the next table header. Refuse mutation if the table is ambiguous, parsing fails, or the server uses an inline/dotted-key form that cannot be byte-locally preserved.

- [ ] **Step 3: Verify nested settings preservation and idempotency**

The transformer must not serialize the whole TOML document because that would erase comments/formatting. Detect the exact runner prefix to prevent double wrapping.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/proxy/codex.test.ts`

Expected: PASS.

```bash
git add packages/core/src/proxy/config/codex.ts packages/core/test/proxy/codex.test.ts fixtures/proxy/codex
git commit -m "feat(core): wrap Codex stdio MCP configs"
```

---

### Task P4: Gemini Configuration Transformer

**Files:**
- Create: `packages/core/src/proxy/config/gemini.ts`
- Create: `packages/core/test/proxy/gemini.test.ts`
- Create: `fixtures/proxy/gemini/user-settings.json`
- Create: `fixtures/proxy/gemini/project-settings.json`

**Interfaces:**
- Produces: `discoverGeminiProxyCandidates(paths): ProxyCandidate[]`.
- Produces: `wrapGeminiServer(text, target, runner): ProxyMutation`.
- Preserves system/workspace/user precedence and refuses system scope mutation.

- [ ] **Step 1: Write scope and preservation tests**

Test stdio `command/args/env/cwd/timeout/trust/includeTools/excludeTools`, HTTP `url/httpUrl`, unrelated Gemini settings, duplicate names at different scopes, and already wrapped servers.

- [ ] **Step 2: Implement discovery and wrapping**

Use the same outer-field preservation pattern as Claude but client `gemini-cli`. Mark system candidates `editable:false`; user/workspace candidates are editable only when the file is writable.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run packages/core/test/proxy/gemini.test.ts`

Expected: PASS.

```bash
git add packages/core/src/proxy/config/gemini.ts packages/core/test/proxy/gemini.test.ts fixtures/proxy/gemini
git commit -m "feat(core): wrap Gemini stdio MCP configs"
```

---

### Task P5: VS Code Consent, New-Server Detection, and Status UX

**Files:**
- Create: `packages/extension/src/proxyConsent.ts`
- Create: `packages/extension/src/proxyManager.ts`
- Create: `packages/extension/src/proxyStatus.ts`
- Create: `packages/extension/src/proxyWatch.ts`
- Create: `packages/extension/test/proxyConsent.test.ts`
- Create: `packages/extension/test/proxyStatus.test.ts`
- Modify: `packages/extension/src/extension.ts`
- Modify: `packages/extension/src/autoScan.ts`
- Modify: `packages/extension/package.json`
- Modify: `packages/extension/esbuild.mjs`
- Modify: `packages/extension/scripts/bundle-smoke.mjs`

**Interfaces:**
- Commands: `mcp-lens.proxyEnable`, `proxyDisable`, `proxyDoctor`, `proxyResetDecision`.
- Setting: `mcpLens.proxyPromptPolicy` enum `ask-new|never`, default `ask-new`.
- Reuses `watchConfigSources()` 2-second debounce.

- [ ] **Step 1: Write pure prompt decision tests**

```ts
expect(decideProxyPrompt({ policy: 'ask-new', candidates: [newServer], registry: [] }))
  .toEqual({ kind: 'prompt', targets: [newServer] });
expect(decideProxyPrompt({ policy: 'ask-new', candidates: [newServer],
  registry: [declined(newServer)] })).toEqual({ kind: 'skip' });
```

Test enabled, deferred <30 days, deferred ≥30 days, declined, drifted, HTTP, managed, already wrapped, and Proxy-generated config change.

- [ ] **Step 2: Implement first consent screen**

Show discovered eligible servers in QuickPick with multi-select. Before applying, show a modal summarizing traffic visibility, failure risk, local-only metadata, target scope, and project Git warning. No selection or dismissal leaves config unchanged.

- [ ] **Step 3: Implement new-server prompt**

After config watcher debounce and definition scan, recompute `configSources()`, add/remove watched paths, then compare scoped candidate identities with registry. Offer exact actions `Proxy 연결`, `이번에는 건너뜀`, `이 서버는 다시 묻지 않음`; persist enabled/deferred/declined respectively. Never prompt for the mutation written by MCP Lens itself.

- [ ] **Step 4: Implement apply/rollback/status**

Install runner, write `operation:'enabling'`, compare-and-swap the expected file hash, apply client transformer, reparse config, start proxy-wrapped `initialize→tools/list` verification, persist enabled only on success, and rollback on failure. Display Hook/Log/Proxy/Config status as independent rows.

Before P5 starts, reconcile and commit the pre-existing user changes in `packages/extension/esbuild.mjs` and `packages/extension/scripts/bundle-smoke.mjs`; the P5 worktree must branch from that resolved baseline. P5 extends those files to package/checksum the runner and must not overwrite unrelated changes.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run packages/extension/test/proxyConsent.test.ts packages/extension/test/proxyStatus.test.ts && npm run typecheck -w mcp-lens && npm run build -w mcp-lens`

Expected: PASS.

```bash
git add packages/extension/src/proxyConsent.ts packages/extension/src/proxyManager.ts packages/extension/src/proxyStatus.ts packages/extension/src/proxyWatch.ts packages/extension/src/extension.ts packages/extension/src/autoScan.ts packages/extension/test packages/extension/package.json packages/extension/esbuild.mjs packages/extension/scripts/bundle-smoke.mjs
git commit -m "feat(extension): add consent-based proxy setup"
```

---

### Task P6: CLI Proxy Commands

**Files:**
- Create: `packages/cli/src/proxy-command.ts`
- Create: `packages/cli/src/proxy-format.ts`
- Create: `packages/cli/test/proxy-command.test.ts`
- Modify: `packages/cli/src/main.ts`

**Interfaces:**
- Commands: `proxy status [--json]`, `enable <client> <server>`, `disable <client> <server>`, `doctor <client> <server>`, `policy ask-new|never`.
- Mutating commands require explicit target; no `enable all` command.

- [ ] **Step 1: Write command parsing and output contract tests**

Test invalid client/server, HTTP unsupported, managed read-only, project warning requiring `--yes`, enabled idempotency, drift refusal, disable restoration, and stable JSON output.

- [ ] **Step 2: Implement dry-run-first command behavior**

`enable` prints before/after command summary and asks on TTY; non-interactive mode requires `--yes`. `status` and `doctor` are read-only. `disable` refuses drift unless user manually resolves it; no force overwrite option in v1.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run packages/cli/test/proxy-command.test.ts packages/cli/test && npm run build -w @mcp-lens/cli`

Expected: PASS.

```bash
git add packages/cli/src/proxy-command.ts packages/cli/src/proxy-format.ts packages/cli/src/main.ts packages/cli/test/proxy-command.test.ts
git commit -m "feat(cli): manage consent stdio proxy"
```

---

### Task P7: Proxy Observations and Three-Source Reconciliation

**Files:**
- Create: `packages/core/src/proxy/observation.ts`
- Create: `packages/core/test/proxy/observation.test.ts`
- Modify: `packages/core/src/store/observations.ts`
- Modify: `packages/core/src/health/collectionHealth.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes H0 `ToolObservation` and P1 proxy receipt.
- Produces: `proxyReceiptToObservation()` and field-level Hook/log/Proxy merge.

- [ ] **Step 1: Write three-source dedupe tests**

For one native call, ingest Hook completion, transcript result, and Proxy response in every order. Assert one canonical call; Hook owns session/error, log owns response/load tokens, Proxy supplies wire duration/error only when Hook lacks them. The Proxy request ID is connection-local, not a client session ID, so it may be linked only when exactly one Hook/log candidate matches server, tool, and the time window.

- [ ] **Step 2: Write proxy-only health tests**

Proxy-only calls are lower-confidence fallback evidence and never prove model context token usage. A Proxy/Hook mismatch becomes degraded only after existing hysteresis thresholds.

- [ ] **Step 3: Implement conversion and precedence**

Proxy request IDs are connection-local, not client session IDs. Correlate by client/server/tool and a bounded time window only when exactly one Hook/log candidate exists; otherwise retain an unlinked Proxy observation. Never merge two ambiguous concurrent calls solely by tool name. An unlinked observation does not increase an existing Hook/log canonical count; proxy-only reporting uses a synthetic `proxy:<process-instance-id>` session and explicitly low confidence.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run packages/core/test/proxy/observation.test.ts packages/core/test/store/observations.test.ts packages/core/test/health`

Expected: PASS.

```bash
git add packages/core/src/proxy/observation.ts packages/core/src/store/observations.ts packages/core/src/health/collectionHealth.ts packages/core/src/index.ts packages/core/test/proxy/observation.test.ts
git commit -m "feat(core): reconcile proxy observations"
```

---

### Task P8: Proxy Integration, Rollback, and Real-Client Smoke

**Files:**
- Create: `packages/core/test/e2e/proxy-pipeline.test.ts`
- Create: `packages/core/test/e2e/proxy-config-lifecycle.test.ts`
- Modify: `docs/SMOKE.md`
- Modify: `docs/system-flow.md`
- Modify: `packages/extension/README.md`

**Interfaces:**
- Validates P0-P7; adds no new product API.

- [ ] **Step 1: Add config lifecycle E2E**

For all three clients: discover → prompt target → enable → validate → detect same config as known → disable → exact original restore. Add declined/no-repeat, deferred/30-day, install failure rollback, validation failure rollback, drift/no-overwrite, HTTP/no-change cases.

- [ ] **Step 2: Add runtime pipeline E2E**

Run dummy MCP server directly and through Proxy. Compare initialize/tools/list/tools/call/cancel/error stdout bytes, assert metadata observations, then merge Hook/log/Proxy fixtures into one canonical matrix.

- [ ] **Step 3: Run repository verification**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run build`

Expected: core, proxy, CLI, extension, dashboard build.

Run: `npm run typecheck -w mcp-lens && npm run smoke -w mcp-lens`

Expected: PASS.

- [ ] **Step 4: Run real-client smoke serially**

For Claude, Codex, Gemini separately: register one disposable stdio dummy server, accept Proxy prompt, restart client, call success/failure tools, verify Hook+log+Proxy one-call materialization, add a second server and verify one prompt, decline it and verify no repeat, disable Proxy and confirm exact restoration. Never use a real credential-bearing server.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/e2e/proxy-pipeline.test.ts packages/core/test/e2e/proxy-config-lifecycle.test.ts docs/SMOKE.md docs/system-flow.md packages/extension/README.md
git commit -m "test: verify consent stdio proxy lifecycle"
```

---

## Wave Merge Gates

At each wave boundary:

```bash
git diff --check
npm test
npm run build
git status --short
```

Reject any branch that silently wraps a server, rewrites an HTTP/managed config, stores payload bodies, points config into a versioned VS Code extension directory, serializes all Codex TOML and loses comments, or restores over drifted user settings.

## Definition of Done

- P0-P8 are merged after Hook H12.
- Existing servers are wrapped only after server-specific consent.
- New eligible servers produce one `ask-new` prompt and never auto-wrap.
- Declined decisions suppress future prompts until reset.
- STDIO JSON-RPC behavior is byte-transparent.
- Install/validation failures restore original config.
- Drift prevents automatic overwrite or restoration.
- Proxy disable preserves every unrelated MCP/Hook setting.
- HTTP/Web/managed environments remain unchanged and clearly labeled.
- Full test/build/typecheck/smoke and three-client serial smoke pass.
