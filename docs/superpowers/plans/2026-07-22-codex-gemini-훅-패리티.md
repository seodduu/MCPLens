# Codex·Gemini 훅 수집 패리티 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codex·gemini를 claude와 동일하게 훅 감지·원클릭 설치·클라이언트별 수집 건강도로 다루도록 VS Code 확장을 확장한다.

**Architecture:** 수집 계약·런타임 패키지(`codex-plugin`·`gemini-extension`)는 이미 존재한다. 이 계획은 확장 쪽에서 (1) `ClientHookInstaller` 인터페이스로 3개 클라이언트 설치기를 통합, (2) 번들에 codex·gemini 산출물 포함, (3) `ingest_observations.client`로 클라이언트별 건강도 파생, (4) 수집 트리를 클라이언트별 행+설치 액션으로 렌더, (5) 통합 시작 넛지를 구현한다.

**Tech Stack:** TypeScript, VS Code Extension API, sql.js(SQLite), esbuild, vitest. 설치는 `claude`/`codex`/`gemini` CLI 셸 아웃.

## Global Constraints

- 공유 계약 파일 수정 금지: `packages/core/src/types.ts`, `packages/core/src/store/schema.sql`, 루트 설정. (per-client는 기존 `ingest_observations.client` 열로 스키마 변경 없이 가능)
- core에서 `vscode` import 금지. DB 경로는 `~/.mcplens/lens.db` (`dbPath()`), `os.homedir()`+`path.join` 사용, `~` 하드코딩 금지.
- 유닛 테스트는 픽스처 + `:memory:` DB만 사용 (터미널 병렬 안전). CLI 셸 아웃은 반드시 목킹 — 테스트에서 실제 `codex`/`gemini`/`claude` 기동 금지.
- 수집기 설치·실패가 사용자의 MCP 호출로 전파되지 않는다: 설치기는 throw 대신 `InstallResult` 유니온 반환, 감지는 fail-open(`not-installed`/`client-missing`).
- 플러그인 식별자: Claude `mcp-lens@mcplens`, Codex `mcp-lens@mcplens`, Gemini 확장명 `mcp-lens`.
- 설계 문서: `docs/superpowers/specs/2026-07-22-codex-gemini-훅-패리티-design.md` (진실 원천).

---

## 범위 밖 (이 계획에서 다루지 않음)

- **설계 §5.4 클라이언트별 권고 게이트 배선**: `gateRecommendation`은 현재 **어디서도 호출되지 않는 죽은 코드**이고 `buildReport`는 health를 받지 않는다. 이를 per-client로 배선하려면 core 리포트 파이프라인을 바꿔야 하며, 이는 파리티(설치·감지·건강도 표시)와 직교하고 리포트 출력 회귀 위험이 있다. 본 계획은 그 전제인 `collectionHealthByClient()`만 제공하고, 실제 게이트 배선은 별도 후속 작업으로 남긴다.

---

## 터미널 분배 (웨이브 / 의존성)

터미널 1개 = worktree 1개 = 브랜치 1개. 오케스트레이터(이 세션, opus)가 스폰·리뷰·머지 게이트를 담당한다.

| 웨이브 | 터미널 | 브랜치 | 태스크 | 파일 소유(배타) | 서브에이전트 모델 |
|---|---|---|---|---|---|
| **1** | **A: Core** | `feat/hook-parity-core` | A1 | `packages/core/src/store/store.ts`(+test) | sonnet |
| **1** | **B: Installers+Bundle** | `feat/hook-parity-installers` | B1·B2·B3·B4·B5 | `packages/extension/src/hookInstall.ts`, `installers/*`, `claudeCli.ts`, `esbuild.mjs`, `assets/*`(+tests) | B2·B3 **opus**, 나머지 sonnet |
| **2** | **C: Integration** | `feat/hook-parity-integration` | C1·C2·C3·C4 | `packages/extension/src/hookStatus.ts`, `hookStatusProvider.ts`, `extension.ts`, `package.json`(+tests) | sonnet |

**의존성**: Wave 1의 A·B는 파일이 서로 배타적 → **동시 실행 가능**. Wave 2의 C는 A의 `collectionHealthByClient()`와 B의 설치기를 소비 → **A·B를 main에 머지한 뒤** 시작한다.

**모델 근거** (CLAUDE.md): 기본 sonnet. B2·B3(codex·gemini 설치기)는 실제 CLI 출력 포맷·마켓플레이스 스냅샷 구조를 실측과 대조해 판단해야 하는 **어댑터 성격**이라 opus.

### Wave 1 실행 프롬프트 (각 터미널에 그대로 붙여넣기)

**터미널 A (Core):**
```
당신은 MCP Lens의 Core 태스크 실행 오케스트레이터입니다. worktree를 feat/hook-parity-core 브랜치로 만들고(superpowers:using-git-worktrees), docs/superpowers/plans/2026-07-22-codex-gemini-훅-패리티.md 의 "Task A1"만 구현하세요. superpowers:subagent-driven-development로 태스크당 서브에이전트(model: sonnet)를 스폰하고, 각 태스크 후 테스트 통과 + Files 목록 밖 파일 미수정을 리뷰하세요. types.ts·schema.sql은 수정 금지. 완료 후 npx vitest run 전체 통과를 확인하고 보고하세요.
```

**터미널 B (Installers + Bundle):**
```
당신은 MCP Lens의 확장 설치기 태스크 실행 오케스트레이터입니다. worktree를 feat/hook-parity-installers 브랜치로 만들고(superpowers:using-git-worktrees), docs/superpowers/plans/2026-07-22-codex-gemini-훅-패리티.md 의 "Task B1"→"B2"→"B3"→"B4"→"B5"를 순서대로 구현하세요. superpowers:subagent-driven-development로 태스크당 서브에이전트를 스폰하되 B2·B3는 model: opus, 나머지는 sonnet. B2·B3는 계획서의 "연구 단계"를 반드시 먼저 수행해 실제 codex/gemini CLI·마켓플레이스 포맷을 실측과 대조하세요. 테스트에서 실제 CLI 기동 금지(전부 목킹). 각 태스크 후 리뷰. 완료 후 npm --prefix packages/extension run build && npm --prefix packages/extension run typecheck 통과를 확인하고 보고하세요.
```

### Wave 2 실행 프롬프트 (A·B 머지 후)

**터미널 C (Integration):**
```
당신은 MCP Lens의 확장 통합 태스크 실행 오케스트레이터입니다. 먼저 main에 feat/hook-parity-core·feat/hook-parity-installers가 머지됐는지 확인하세요(collectionHealthByClient와 installers/가 존재해야 함). worktree를 feat/hook-parity-integration 브랜치로 만들고(superpowers:using-git-worktrees), docs/superpowers/plans/2026-07-22-codex-gemini-훅-패리티.md 의 "Task C1"→"C2"→"C3"→"C4"를 순서대로 구현하세요. superpowers:subagent-driven-development로 태스크당 서브에이전트(model: sonnet)를 스폰하고 각 태스크 후 리뷰. 완료 후 npx vitest run + npm --prefix packages/extension run build && typecheck 통과를 확인하고 보고하세요.
```

---

# Wave 1 · 터미널 A — Core

### Task A1: 클라이언트별 수집 건강도

**Files:**
- Modify: `packages/core/src/store/store.ts` (`collectionHealth()` 근처, 약 141행)
- Test: `packages/core/test/store/collectionHealthByClient.test.ts`

**Interfaces:**
- Consumes: 기존 순수 함수 `deriveCollectionHealth({ now, observations })` (`packages/core/src/health/collectionHealth.ts`), 타입 `CollectionHealthSnapshot`, `ClientId`(`../types.js`).
- Produces: `LensStore.collectionHealthByClient(now?: string): Map<ClientId, CollectionHealthSnapshot>` — `ingest_observations`를 `client`로 그룹핑해 각 그룹에 `deriveCollectionHealth`를 적용한 맵. 관측이 전무한 클라이언트는 맵에 없음.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/store/collectionHealthByClient.test.ts
import { describe, it, expect } from 'vitest';
import { LensStore } from '../../src/store/store.js';

async function seed() {
  const store = await LensStore.open(':memory:');
  const base = {
    correlationConfidence: 'exact', externalTurnId: null, externalCallId: null,
    transcriptPath: null, serverName: 'github', durationMs: null, isError: null,
    responseTokens: null, loadedTokens: null, inputFingerprint: null,
  } as const;
  // claude: hook + log 일치 → healthy
  store.enqueueObservation({ ...base, observationId: 'c-h', correlationKey: 'k1',
    source: 'hook', client: 'claude-code', phase: 'post-tool-use',
    externalSessionId: 's-c', toolName: 'x', observedAt: '2026-07-22T00:00:00.000Z',
    receivedAt: '2026-07-22T00:00:00.000Z' });
  store.enqueueObservation({ ...base, observationId: 'c-l', correlationKey: 'k1',
    source: 'log', client: 'claude-code', phase: 'post-tool-use',
    externalSessionId: 's-c', toolName: 'x', observedAt: '2026-07-22T00:00:00.000Z',
    receivedAt: '2026-07-22T00:00:00.000Z' });
  // codex: log만 → log-only
  store.enqueueObservation({ ...base, observationId: 'x-l', correlationKey: 'k2',
    source: 'log', client: 'codex', phase: 'post-tool-use',
    externalSessionId: 's-x', toolName: 'y', observedAt: '2026-07-22T00:00:00.000Z',
    receivedAt: '2026-07-22T00:00:00.000Z' });
  return store;
}

describe('collectionHealthByClient', () => {
  it('클라이언트별로 건강도를 분리 파생한다', async () => {
    const store = await seed();
    const byClient = store.collectionHealthByClient('2026-07-22T01:00:00.000Z');
    expect(byClient.get('claude-code')?.health).toBe('healthy');
    expect(byClient.get('codex')?.health).toBe('log-only');
    expect(byClient.has('gemini-cli')).toBe(false); // 관측 없음
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/store/collectionHealthByClient.test.ts`
Expected: FAIL — `store.collectionHealthByClient is not a function`.

> 주: `enqueueObservation`의 정확한 필드는 `packages/core/src/store/store.ts`의 기존 `insertObservation`/`ToolObservation` 타입을 따른다. 위 `base`가 컴파일되지 않으면 그 타입에 맞춰 필드를 채운 뒤 테스트를 다시 실패시킨다(테스트가 여전히 `collectionHealthByClient` 부재로 실패해야 함).

- [ ] **Step 3: Write minimal implementation**

`store.ts`의 `collectionHealth(now = ...)` 메서드 바로 아래에 추가한다. 기존 `collectionHealth`의 select를 `client`까지 뽑아 그룹핑한다.

```ts
  collectionHealthByClient(now = new Date().toISOString()): Map<ClientId, CollectionHealthSnapshot> {
    const rows = this.select(
      'SELECT client, source, phase, correlation_key, observed_at FROM ingest_observations ORDER BY observed_at, observation_id', [],
    );
    const byClient = new Map<ClientId, {
      source: 'hook' | 'log'; phase: ToolObservation['phase'];
      correlationKey: string; observedAt: string;
    }[]>();
    for (const row of rows) {
      const client = row.client as ClientId;
      const list = byClient.get(client) ?? [];
      list.push({
        source: row.source as 'hook' | 'log', phase: row.phase as ToolObservation['phase'],
        correlationKey: row.correlation_key as string, observedAt: row.observed_at as string,
      });
      byClient.set(client, list);
    }
    const result = new Map<ClientId, CollectionHealthSnapshot>();
    for (const [client, observations] of byClient) {
      result.set(client, deriveCollectionHealth({ now, observations }));
    }
    return result;
  }
```

`ClientId`가 이 파일에 import돼 있지 않으면 상단 `import type { ... } from '../types.js'`에 추가한다 (`ToolObservation`, `CollectionHealthSnapshot`, `deriveCollectionHealth`는 이미 import됨).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/store/collectionHealthByClient.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Run full core suite (회귀 확인)**

Run: `npx vitest run packages/core`
Expected: 전부 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/store/store.ts packages/core/test/store/collectionHealthByClient.test.ts
git commit -m "feat(core): 클라이언트별 수집 건강도 파생(collectionHealthByClient)"
```

---

# Wave 1 · 터미널 B — Installers + Bundle

### Task B1: 설치기 인터페이스 + Claude 구현 리팩터

**Files:**
- Modify: `packages/extension/src/hookInstall.ts` (전체 — 인터페이스화)
- Modify: `packages/extension/src/claudeCli.ts` (제네릭 바이너리 탐색 추가)
- Test: `packages/extension/test/hookInstall.test.ts` (기존 있으면 확장, 없으면 생성)

**Interfaces:**
- Produces:
  - `type HookClient = 'claude-code' | 'codex' | 'gemini-cli'`
  - `interface RunResult { stdout: string; stderr: string; code: number }` (기존 유지, export)
  - `interface InstallerDeps { home: string; findBinary: (name: string) => string | null; run: (bin: string, args: string[]) => Promise<RunResult>; fs: { copyDir; exists; readDir }; bundledDir: string }`
  - `interface ClientHookInstaller { readonly client: HookClient; detect(): Promise<InstallState>; install(): Promise<InstallResult>; uninstall(): Promise<InstallResult> }`
  - `type InstallState = 'installed' | 'not-installed' | 'client-missing'`
  - `type InstallResult = { kind: 'ok'; alreadyInstalled: boolean } | { kind: 'client-missing' } | { kind: 'failed'; step: string; stderr: string }`
  - `class ClaudeHookInstaller implements ClientHookInstaller`
  - `function stableDir(home: string, sub: string): string` (`~/.mcplens/<sub>`)
- Consumes: `claudeCli.ts`의 `findBinary`, `runBin`, `nodeFs`.

- [ ] **Step 1: Write the failing test** — Claude 설치기가 인터페이스대로 감지/설치한다.

```ts
// packages/extension/test/hookInstall.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudeHookInstaller, type InstallerDeps, type RunResult } from '../src/hookInstall.js';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    home: '/home/u',
    findBinary: () => '/bin/claude',
    run: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fs: { copyDir: () => {}, exists: () => false, readDir: () => [] },
    bundledDir: '/bundle/claude-marketplace',
    ...over,
  };
}

describe('ClaudeHookInstaller', () => {
  it('plugin list에 mcp-lens@mcplens 있으면 installed', async () => {
    const run = async (_b: string, _a: string[]): Promise<RunResult> =>
      ({ stdout: JSON.stringify([{ id: 'mcp-lens@mcplens' }]), stderr: '', code: 0 });
    const inst = new ClaudeHookInstaller(deps({ run }));
    expect(await inst.detect()).toBe('installed');
  });

  it('바이너리 없으면 client-missing', async () => {
    const inst = new ClaudeHookInstaller(deps({ findBinary: () => null }));
    expect(await inst.detect()).toBe('client-missing');
  });

  it('install은 marketplace add → plugin install 순서로 호출한다', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a); return { stdout: '', stderr: '', code: 0 };
    };
    const inst = new ClaudeHookInstaller(deps({
      run, findBinary: () => '/bin/claude',
      // detect가 not-installed이 되도록 plugin list는 빈 배열
    }));
    // detect(list)=[] → not-installed → 설치 진행
    await inst.install();
    expect(calls.some((a) => a.includes('marketplace') && a.includes('add'))).toBe(true);
    expect(calls.some((a) => a.includes('install') && a.includes('mcp-lens@mcplens'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/extension/test/hookInstall.test.ts`
Expected: FAIL — `ClaudeHookInstaller`/`InstallerDeps` export 없음.

- [ ] **Step 3: Generalize claudeCli.ts** — `findBinary(name)`/`runBin` 추가(기존 함수는 얇게 위임).

```ts
// claudeCli.ts 에 추가
const BIN_CANDIDATES = (name: string): string[] => [
  join(homedir(), '.local', 'bin', name),
  join(homedir(), '.nvm', 'current', 'bin', name), // best-effort
  `/opt/homebrew/bin/${name}`,
  `/usr/local/bin/${name}`,
];

export function findBinary(name: string): string | null {
  for (const c of BIN_CANDIDATES(name)) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export const runBin = runClaude; // spawn(bin,args)는 이미 클라이언트 무관
```

`findClaudeBinary`는 `findBinary('claude')`로 위임하도록 본문 교체(호출부 호환 유지).

- [ ] **Step 4: Rewrite hookInstall.ts** — 인터페이스 + Claude 구현.

`InstallState`/`InstallResult`/`RunResult`는 기존 유지하고 아래를 도입한다. 기존 `installClaudeHooks`/`detectClaudeHookInstall`/`uninstallClaudeHooks` 함수는 `ClaudeHookInstaller` 클래스로 이전하고, 기존 함수는 클래스를 감싸는 얇은 래퍼로 남겨 `extension.ts` 호환을 유지한다.

```ts
export type HookClient = 'claude-code' | 'codex' | 'gemini-cli';

export interface InstallerDeps {
  home: string;
  findBinary: (name: string) => string | null;
  run: (bin: string, args: string[]) => Promise<RunResult>;
  fs: { copyDir: (from: string, to: string) => void; exists: (p: string) => boolean; readDir: (p: string) => string[] };
  bundledDir: string; // dist/<...> 번들 경로
}

export interface ClientHookInstaller {
  readonly client: HookClient;
  detect(): Promise<InstallState>;
  install(): Promise<InstallResult>;
  uninstall(): Promise<InstallResult>;
}

export function stableDir(home: string, sub: string): string {
  return join(home, '.mcplens', sub);
}

export const PLUGIN_ID = 'mcp-lens@mcplens';
export const MARKETPLACE_NAME = 'mcplens';

export class ClaudeHookInstaller implements ClientHookInstaller {
  readonly client = 'claude-code' as const;
  constructor(private deps: InstallerDeps) {}
  private bin(): string | null { return this.deps.findBinary('claude'); }

  async detect(): Promise<InstallState> {
    const bin = this.bin();
    if (bin === null) return 'client-missing';
    try {
      const r = await this.deps.run(bin, ['plugin', 'list', '--json']);
      if (r.code === 0) {
        try {
          const arr = JSON.parse(r.stdout);
          const has = Array.isArray(arr) && arr.some((p) => (p as { id?: unknown })?.id === PLUGIN_ID);
          return has ? 'installed' : 'not-installed';
        } catch { return 'not-installed'; }
      }
    } catch { /* fall through */ }
    return 'not-installed';
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin();
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };
    const target = stableDir(this.deps.home, 'claude-marketplace');
    try { this.deps.fs.copyDir(this.deps.bundledDir, target); }
    catch (e) { return { kind: 'failed', step: 'copy', stderr: msg(e) }; }
    const add = await this.deps.run(bin, ['plugin', 'marketplace', 'add', target]);
    if (add.code !== 0 && !alreadyPresent(add.stderr)) return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
    const ins = await this.deps.run(bin, ['plugin', 'install', PLUGIN_ID]);
    if (ins.code !== 0 && !alreadyPresent(ins.stderr)) return { kind: 'failed', step: 'install', stderr: ins.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin();
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.deps.run(bin, ['plugin', 'uninstall', PLUGIN_ID]);
    if (un.code !== 0 && !/not installed|no such/i.test(un.stderr)) return { kind: 'failed', step: 'uninstall', stderr: un.stderr };
    await this.deps.run(bin, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    return { kind: 'ok', alreadyInstalled: false };
  }
}

function alreadyPresent(s: string): boolean { return /already (exists|added|installed)/i.test(s); }
function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
```

기존 `installClaudeHooks(deps: HookInstallDeps)` 등은 다음처럼 얇게 유지(호환):

```ts
// 호환 래퍼 — extension.ts가 아직 옛 시그니처를 쓰는 동안 유지. Task C3에서 제거 예정.
export async function detectClaudeHookInstall(deps: HookInstallDeps): Promise<InstallState> {
  return new ClaudeHookInstaller(toInstallerDeps(deps, 'claude-marketplace')).detect();
}
// installClaudeHooks/uninstallClaudeHooks 동일 패턴. toInstallerDeps는 기존 HookInstallDeps→InstallerDeps 어댑터.
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run packages/extension/test/hookInstall.test.ts`
Expected: PASS. 이어 `npm --prefix packages/extension run typecheck` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/hookInstall.ts packages/extension/src/claudeCli.ts packages/extension/test/hookInstall.test.ts
git commit -m "refactor(extension): ClientHookInstaller 인터페이스 + Claude 구현 분리"
```

---

### Task B2: Codex 설치기 (model: opus)

**연구 단계 (구현 전 필수):** codex 마켓플레이스 스냅샷 포맷을 실측한다.
```bash
codex plugin list --json | head -30          # detect 포맷 확인: installed[].pluginId, .installed
cat "$HOME/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json"  # 마켓플레이스 매니페스트 스키마
codex plugin marketplace add --help; codex plugin add --help  # 인자 확인
```
이 실측으로 `assets/codex-marketplace.json`의 스키마와 스냅샷 디렉토리 구조(`.agents/plugins/marketplace.json` + 플러그인 dir)를 확정한 뒤 구현한다. **계획서 값과 실측이 다르면 실측이 진실**이다.

**Files:**
- Create: `packages/extension/src/installers/codex.ts`
- Create: `packages/extension/assets/codex-marketplace.json` (연구 단계 결과로 스키마 확정)
- Test: `packages/extension/test/installers/codex.test.ts`
- Fixture: `packages/extension/test/fixtures/codex-plugin-list.json`

**Interfaces:**
- Consumes: `ClientHookInstaller`, `InstallerDeps`, `InstallState`, `InstallResult`, `PLUGIN_ID`, `stableDir` (Task B1).
- Produces: `class CodexHookInstaller implements ClientHookInstaller` (`client = 'codex'`).

- [ ] **Step 1: Fixture 저장** — 실측 `codex plugin list --json`을 픽스처로.

```json
// packages/extension/test/fixtures/codex-plugin-list.json
{ "installed": [
  { "pluginId": "documents@openai-primary-runtime", "installed": true, "enabled": true },
  { "pluginId": "mcp-lens@mcplens", "installed": true, "enabled": true }
] }
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/extension/test/installers/codex.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexHookInstaller } from '../../src/installers/codex.js';
import type { InstallerDeps, RunResult } from '../../src/hookInstall.js';

const listJson = readFileSync(join(__dirname, '../fixtures/codex-plugin-list.json'), 'utf8');
function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return { home: '/home/u', findBinary: () => '/bin/codex',
    run: async () => ({ stdout: listJson, stderr: '', code: 0 }),
    fs: { copyDir: () => {}, exists: () => false, readDir: () => [] },
    bundledDir: '/bundle/codex-marketplace', ...over };
}

describe('CodexHookInstaller', () => {
  it('plugin list --json에 mcp-lens@mcplens installed면 installed', async () => {
    expect(await new CodexHookInstaller(deps()).detect()).toBe('installed');
  });
  it('없으면 not-installed', async () => {
    const run = async (): Promise<RunResult> => ({ stdout: '{"installed":[]}', stderr: '', code: 0 });
    expect(await new CodexHookInstaller(deps({ run })).detect()).toBe('not-installed');
  });
  it('바이너리 없으면 client-missing', async () => {
    expect(await new CodexHookInstaller(deps({ findBinary: () => null })).detect()).toBe('client-missing');
  });
  it('install은 marketplace add → plugin add 순서', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a);
      if (a.includes('list')) return { stdout: '{"installed":[]}', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await new CodexHookInstaller(deps({ run })).install();
    expect(calls.some((a) => a.join(' ').includes('marketplace add'))).toBe(true);
    expect(calls.some((a) => a.includes('add') && a.includes('mcp-lens@mcplens'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/extension/test/installers/codex.test.ts`
Expected: FAIL — `CodexHookInstaller` 없음.

- [ ] **Step 4: Implement** — 감지는 JSON(`installed[].pluginId`)으로 결정론적. 설치는 연구 단계에서 확정한 스냅샷 경로/명령으로.

```ts
// packages/extension/src/installers/codex.ts
import { join } from 'node:path';
import type { ClientHookInstaller, InstallerDeps, InstallState, InstallResult } from '../hookInstall.js';
import { PLUGIN_ID, MARKETPLACE_NAME, stableDir } from '../hookInstall.js';

export class CodexHookInstaller implements ClientHookInstaller {
  readonly client = 'codex' as const;
  constructor(private deps: InstallerDeps) {}
  private bin(): string | null { return this.deps.findBinary('codex'); }

  async detect(): Promise<InstallState> {
    const bin = this.bin();
    if (bin === null) return 'client-missing';
    try {
      const r = await this.deps.run(bin, ['plugin', 'list', '--json']);
      if (r.code === 0) {
        try {
          const parsed = JSON.parse(r.stdout) as { installed?: { pluginId?: string; installed?: boolean }[] };
          const has = (parsed.installed ?? []).some((p) => p.pluginId === PLUGIN_ID && p.installed !== false);
          return has ? 'installed' : 'not-installed';
        } catch { return 'not-installed'; }
      }
    } catch { /* fall through */ }
    return 'not-installed';
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin();
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };
    const target = stableDir(this.deps.home, 'codex-marketplace');
    try { this.deps.fs.copyDir(this.deps.bundledDir, target); }
    catch (e) { return { kind: 'failed', step: 'copy', stderr: e instanceof Error ? e.message : String(e) }; }
    const add = await this.deps.run(bin, ['plugin', 'marketplace', 'add', target]);
    if (add.code !== 0 && !/already/i.test(add.stderr)) return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
    const ins = await this.deps.run(bin, ['plugin', 'add', PLUGIN_ID]);
    if (ins.code !== 0 && !/already/i.test(ins.stderr)) return { kind: 'failed', step: 'add', stderr: ins.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin();
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.deps.run(bin, ['plugin', 'remove', PLUGIN_ID]);
    if (un.code !== 0 && !/not installed|no such/i.test(un.stderr)) return { kind: 'failed', step: 'remove', stderr: un.stderr };
    await this.deps.run(bin, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    return { kind: 'ok', alreadyInstalled: false };
  }
}
```

> 연구 단계에서 `plugin marketplace remove`가 이름이 아니라 경로/다른 인자를 요구하면 실측에 맞춰 수정한다. 스냅샷 디렉토리 구조가 `.agents/plugins/marketplace.json`을 요구하면 `esbuild.mjs`(Task B4)가 그 구조로 번들하도록 맞춘다.

- [ ] **Step 5: Run tests** — `npx vitest run packages/extension/test/installers/codex.test.ts` PASS + `typecheck` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/installers/codex.ts packages/extension/assets/codex-marketplace.json packages/extension/test/installers/codex.test.ts packages/extension/test/fixtures/codex-plugin-list.json
git commit -m "feat(extension): Codex 훅 설치기(plugin list --json 감지 + 마켓플레이스 설치)"
```

---

### Task B3: Gemini 설치기 (model: opus)

**연구 단계 (구현 전 필수):**
```bash
gemini extensions list -o json           # 빈 상태 []; 설치 시 항목 형태(name 필드) 확인
gemini extensions install --help; gemini extensions uninstall --help
```
설치된 확장의 JSON 항목이 `{ name: "mcp-lens", ... }`인지 문자열인지 실측으로 확정한다. **실측이 진실.**

**Files:**
- Create: `packages/extension/src/installers/gemini.ts`
- Test: `packages/extension/test/installers/gemini.test.ts`

**Interfaces:**
- Consumes: `ClientHookInstaller`, `InstallerDeps`, `InstallState`, `InstallResult` (Task B1).
- Produces: `class GeminiHookInstaller implements ClientHookInstaller` (`client = 'gemini-cli'`). 확장명 상수 `GEMINI_EXT_NAME = 'mcp-lens'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/test/installers/gemini.test.ts
import { describe, it, expect } from 'vitest';
import { GeminiHookInstaller } from '../../src/installers/gemini.js';
import type { InstallerDeps, RunResult } from '../../src/hookInstall.js';

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return { home: '/home/u', findBinary: () => '/bin/gemini',
    run: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fs: { copyDir: () => {}, exists: () => false, readDir: () => [] },
    bundledDir: '/bundle/gemini-extension', ...over };
}

describe('GeminiHookInstaller', () => {
  it('extensions list -o json에 mcp-lens 있으면 installed', async () => {
    const run = async (): Promise<RunResult> =>
      ({ stdout: JSON.stringify([{ name: 'mcp-lens', version: '1.0.0' }]), stderr: '', code: 0 });
    expect(await new GeminiHookInstaller(deps({ run })).detect()).toBe('installed');
  });
  it('빈 목록이면 not-installed', async () => {
    expect(await new GeminiHookInstaller(deps()).detect()).toBe('not-installed');
  });
  it('바이너리 없으면 client-missing', async () => {
    expect(await new GeminiHookInstaller(deps({ findBinary: () => null })).detect()).toBe('client-missing');
  });
  it('install은 extensions install <bundledDir> 호출', async () => {
    const calls: string[][] = [];
    const run = async (_b: string, a: string[]): Promise<RunResult> => {
      calls.push(a);
      if (a.includes('list')) return { stdout: '[]', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await new GeminiHookInstaller(deps({ run })).install();
    expect(calls.some((a) => a.includes('extensions') && a.includes('install') && a.includes('/bundle/gemini-extension'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run packages/extension/test/installers/gemini.test.ts` → FAIL (`GeminiHookInstaller` 없음).

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/installers/gemini.ts
import type { ClientHookInstaller, InstallerDeps, InstallState, InstallResult } from '../hookInstall.js';

export const GEMINI_EXT_NAME = 'mcp-lens';

export class GeminiHookInstaller implements ClientHookInstaller {
  readonly client = 'gemini-cli' as const;
  constructor(private deps: InstallerDeps) {}
  private bin(): string | null { return this.deps.findBinary('gemini'); }

  async detect(): Promise<InstallState> {
    const bin = this.bin();
    if (bin === null) return 'client-missing';
    try {
      const r = await this.deps.run(bin, ['extensions', 'list', '-o', 'json']);
      if (r.code === 0) {
        try {
          const arr = JSON.parse(r.stdout);
          const has = Array.isArray(arr) && arr.some((e) =>
            (typeof e === 'string' ? e : (e as { name?: string })?.name) === GEMINI_EXT_NAME);
          return has ? 'installed' : 'not-installed';
        } catch { return 'not-installed'; }
      }
    } catch { /* fall through */ }
    return 'not-installed';
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin();
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };
    const ins = await this.deps.run(bin, ['extensions', 'install', this.deps.bundledDir]);
    if (ins.code !== 0 && !/already/i.test(ins.stderr)) return { kind: 'failed', step: 'install', stderr: ins.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin();
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.deps.run(bin, ['extensions', 'uninstall', GEMINI_EXT_NAME]);
    if (un.code !== 0 && !/not installed|not found|no such/i.test(un.stderr)) return { kind: 'failed', step: 'uninstall', stderr: un.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }
}
```

> gemini는 경로 직접설치라 마켓플레이스/복사 단계가 없다. 번들 경로를 그대로 install에 넘긴다.

- [ ] **Step 4: Run tests** — `npx vitest run packages/extension/test/installers/gemini.test.ts` PASS + typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/installers/gemini.ts packages/extension/test/installers/gemini.test.ts
git commit -m "feat(extension): Gemini 훅 설치기(extensions list/install 경로 직접설치)"
```

---

### Task B4: 번들링 (dist에 codex·gemini 산출물)

**Files:**
- Modify: `packages/extension/esbuild.mjs` (marketplace 복사 블록, 약 58–70행 뒤)
- Create: `packages/extension/assets/codex-marketplace.json` (Task B2 연구로 스키마 확정; 없으면 B4에서 생성)
- Modify: `packages/extension/scripts/bundle-smoke.mjs` (존재 검사 추가)

**Interfaces:**
- Produces: 빌드 후 `packages/extension/dist/codex-marketplace/`, `packages/extension/dist/gemini-extension/` 디렉토리.

- [ ] **Step 1: Extend esbuild.mjs** — claude 블록 다음에 추가.

```js
// Codex marketplace snapshot: assets/codex-marketplace.json + plugin dir.
// (codex plugin marketplace add <dir> 가 기대하는 구조는 Task B2 연구로 확정)
const codexRoot = join(outdir, 'codex-marketplace');
mkdirSync(join(codexRoot, '.agents/plugins'), { recursive: true });
cpSync(join(here, 'assets/codex-marketplace.json'), join(codexRoot, '.agents/plugins/marketplace.json'));
cpSync(join(here, '../codex-plugin'), join(codexRoot, 'mcp-lens'), {
  recursive: true, filter: (src) => !src.includes(`${'/'}node_modules${'/'}`),
});
console.log('[esbuild] bundled dist/codex-marketplace (Codex hook plugin)');

// Gemini extension: 경로 직접설치라 확장 dir 자체를 복사.
const geminiRoot = join(outdir, 'gemini-extension');
cpSync(join(here, '../gemini-extension'), geminiRoot, {
  recursive: true, filter: (src) => !src.includes(`${'/'}node_modules${'/'}`),
});
console.log('[esbuild] bundled dist/gemini-extension (Gemini hook extension)');
```

- [ ] **Step 2: Build to verify** — Run: `npm --prefix packages/extension run build`. Expected: 로그에 `bundled dist/codex-marketplace`·`bundled dist/gemini-extension`, 그리고
```bash
test -f packages/extension/dist/codex-marketplace/.agents/plugins/marketplace.json && test -d packages/extension/dist/gemini-extension && echo OK
```
Expected: `OK`.

- [ ] **Step 3: bundle-smoke 존재 검사 추가** — `bundle-smoke.mjs` 끝에 두 경로 존재 assert 추가(없으면 `process.exit(1)`).

```js
import { existsSync } from 'node:fs';
for (const p of ['codex-marketplace/.agents/plugins/marketplace.json', 'gemini-extension']) {
  if (!existsSync(join(here, '..', 'dist', p))) { console.error('[smoke] missing bundle:', p); process.exit(1); }
}
```

- [ ] **Step 4: Run smoke** — Run: `npm --prefix packages/extension run smoke`. Expected: 성공 종료.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/esbuild.mjs packages/extension/assets/codex-marketplace.json packages/extension/scripts/bundle-smoke.mjs
git commit -m "build(extension): dist에 codex·gemini 훅 산출물 번들"
```

---

### Task B5: 확장 CLI 헬퍼 정리 (claudeCli 재노출 확인)

**Files:**
- Modify: `packages/extension/src/claudeCli.ts` (export 정리: `findBinary`, `runBin`, `nodeFs`)
- Test: `packages/extension/test/claudeCli.test.ts`

**Interfaces:**
- Produces: `findBinary(name)`, `runBin(bin, args)`, `nodeFs` — Task C3이 3개 설치기 `InstallerDeps`를 조립할 때 사용.

- [ ] **Step 1: Write the failing test** — PATH에서 바이너리를 찾는다.

```ts
// packages/extension/test/claudeCli.test.ts
import { describe, it, expect } from 'vitest';
import { findBinary } from '../src/claudeCli.js';

describe('findBinary', () => {
  it('존재하지 않는 바이너리는 null', () => {
    expect(findBinary('definitely-not-a-real-bin-xyz')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test** — `npx vitest run packages/extension/test/claudeCli.test.ts`. B1에서 이미 `findBinary`를 추가했다면 PASS; 미구현이면 FAIL 후 B1의 구현으로 통과시킨다.

- [ ] **Step 3: Commit** (변경이 있으면)

```bash
git add packages/extension/src/claudeCli.ts packages/extension/test/claudeCli.test.ts
git commit -m "test(extension): 제네릭 findBinary 커버리지"
```

---

# Wave 2 · 터미널 C — Integration (A·B 머지 후)

### Task C1: per-client 표시 상태 합성

**Files:**
- Modify: `packages/extension/src/hookStatus.ts` (상태 합성 함수 추가)
- Test: `packages/extension/test/hookStatus.test.ts`

**Interfaces:**
- Consumes: `CollectionHealthSnapshot`, `formatCollectionHealth` (기존 `hookStatus.ts`), `InstallState` (`hookInstall.ts`).
- Produces: `function clientRowPresentation(install: InstallState, snapshot: CollectionHealthSnapshot | undefined): CollectionHealthPresentation` — 설치상태가 관측건강도를 선점: `not-installed`→미연결(warning), `client-missing`→null 취급(호출부에서 행 제외), 그 외는 `formatCollectionHealth`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/test/hookStatus.test.ts
import { describe, it, expect } from 'vitest';
import { clientRowPresentation } from '../src/hookStatus.js';

const healthy = { health: 'healthy', hookObserved: true, logObserved: true,
  consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null } as const;

describe('clientRowPresentation', () => {
  it('미설치는 미연결(설치 필요)로 표시', () => {
    const p = clientRowPresentation('not-installed', undefined);
    expect(p.label).toContain('미연결');
    expect(p.severity).toBe('warning');
  });
  it('설치+정상은 formatCollectionHealth 결과', () => {
    const p = clientRowPresentation('installed', healthy);
    expect(p.label).toBe('정상');
  });
  it('설치됐지만 관측 없으면 첫 이벤트 대기', () => {
    const p = clientRowPresentation('installed', undefined);
    expect(p.label).toContain('대기');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run packages/extension/test/hookStatus.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `hookStatus.ts`에 추가.

```ts
import type { InstallState } from './hookInstall.js';

export function clientRowPresentation(
  install: InstallState,
  snapshot: CollectionHealthSnapshot | undefined,
): CollectionHealthPresentation {
  if (install === 'not-installed') {
    return { label: '미연결', description: '설치 필요',
      tooltip: '훅이 설치되지 않았습니다. 설치하면 이 클라이언트의 MCP 호출을 수집합니다.', severity: 'warning' };
  }
  // installed: 관측이 있으면 그 건강도, 없으면 idle(첫 이벤트 대기)
  return formatCollectionHealth(
    snapshot ?? { health: 'idle', hookObserved: false, logObserved: false,
      consecutiveMisses: 0, consecutiveMatches: 0, waitingForCorrelation: 0, lastEventAt: null },
    { hooksConfigured: true },
  );
}
```

- [ ] **Step 4: Run tests** — PASS + typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/hookStatus.ts packages/extension/test/hookStatus.test.ts
git commit -m "feat(extension): 설치상태×관측건강도 합성(clientRowPresentation)"
```

---

### Task C2: 수집 트리 클라이언트별 행 + 액션

**Files:**
- Modify: `packages/extension/src/hookStatusProvider.ts` (단일 노드 → 클라이언트별 행)
- Test: `packages/extension/test/hookStatusProvider.test.ts`

**Interfaces:**
- Consumes: `clientRowPresentation` (C1), `InstallState` (`hookInstall.ts`), `CollectionHealthSnapshot`.
- Produces: `HookStatusProvider.setClients(rows: { client: HookClient; install: InstallState; snapshot?: CollectionHealthSnapshot }[])` — 각 행을 TreeItem으로. `client-missing`은 제외. 미설치 행은 `contextValue = 'hook-installable'`, 설치 행은 `contextValue = 'hook-installed'`(메뉴 라우팅용). TreeItem에 `id`로 client를 담아 커맨드가 대상 식별.

> vscode를 import하는 파일이라 유닛 테스트는 렌더 로직만 검증한다. 순수 매핑 함수 `toRow(row): { label; description; contextValue; client }`를 export해 테스트하고, `getTreeItem`은 이를 감싼다.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/test/hookStatusProvider.test.ts
import { describe, it, expect } from 'vitest';
import { toRow } from '../src/hookStatusProvider.js';

describe('toRow', () => {
  it('미설치 클라이언트는 installable + 미연결', () => {
    const r = toRow({ client: 'codex', install: 'not-installed', snapshot: undefined });
    expect(r.contextValue).toBe('hook-installable');
    expect(r.description).toContain('설치 필요');
    expect(r.client).toBe('codex');
  });
  it('설치 클라이언트는 installed', () => {
    const r = toRow({ client: 'claude-code', install: 'installed',
      snapshot: { health: 'healthy', hookObserved: true, logObserved: true,
        consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null } });
    expect(r.contextValue).toBe('hook-installed');
    expect(r.label).toContain('claude-code');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`toRow` 없음).

- [ ] **Step 3: Implement** — provider를 클라이언트별 행으로 재작성.

```ts
import type { HookClient, InstallState } from './hookInstall.js';
import { clientRowPresentation } from './hookStatus.js';

export interface ClientRowInput {
  client: HookClient; install: InstallState; snapshot?: CollectionHealthSnapshot;
}
export interface ClientRow {
  client: HookClient; label: string; description: string;
  tooltip: string; severity: CollectionHealthPresentation['severity'];
  contextValue: 'hook-installable' | 'hook-installed';
}

export function toRow(input: ClientRowInput): ClientRow {
  const p = clientRowPresentation(input.install, input.snapshot);
  return {
    client: input.client,
    label: `${input.client}: ${p.label}`,
    description: p.description, tooltip: p.tooltip, severity: p.severity,
    contextValue: input.install === 'not-installed' ? 'hook-installable' : 'hook-installed',
  };
}

export class HookStatusProvider implements vscode.TreeDataProvider<ClientRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: ClientRow[] = [];

  setClients(inputs: ClientRowInput[]): void {
    this.rows = inputs.filter((i) => i.install !== 'client-missing').map(toRow);
    this.emitter.fire();
  }

  getTreeItem(row: ClientRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.id = row.client;
    item.contextValue = row.contextValue;
    item.iconPath = new vscode.ThemeIcon(ICON[row.severity]);
    return item;
  }
  getChildren(element?: ClientRow): ClientRow[] { return element ? [] : this.rows; }
}
```

`ICON`은 기존 상수 유지. `current()`를 쓰던 `hooksDoctor` 커맨드(extension.ts)는 C3에서 조정한다.

- [ ] **Step 4: Run tests** — PASS + typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/hookStatusProvider.ts packages/extension/test/hookStatusProvider.test.ts
git commit -m "feat(extension): 수집 트리를 클라이언트별 행+설치 액션으로"
```

---

### Task C3: 설치기 배선 · 커맨드 · 통합 넛지

**Files:**
- Modify: `packages/extension/src/extension.ts` (설치기 맵, 커맨드, 넛지, 트리 refresh)
- Test: `packages/extension/test/nudge.test.ts` (넛지 대상 선정 순수 로직)

**Interfaces:**
- Consumes: `ClaudeHookInstaller`·`CodexHookInstaller`·`GeminiHookInstaller`, `findBinary`·`runBin`·`nodeFs`, `store.collectionHealthByClient()`, `detectClients()`, `HookStatusProvider.setClients`.
- Produces: `function pendingHookClients(detected, states, dismissed): HookClient[]` (순수) — 설치돼 있고(`detected`) 훅 미설치(`not-installed`)이며 dismiss 안 된 클라이언트 목록.

- [ ] **Step 1: Write the failing test** (순수 넛지 로직)

```ts
// packages/extension/test/nudge.test.ts
import { describe, it, expect } from 'vitest';
import { pendingHookClients } from '../src/extension.js';

describe('pendingHookClients', () => {
  const detected = new Set(['claude-code', 'codex', 'gemini-cli'] as const);
  it('미설치이고 dismiss 안 된 클라이언트만', () => {
    const states = new Map([['claude-code', 'installed'], ['codex', 'not-installed'], ['gemini-cli', 'not-installed']] as const);
    const dismissed = new Set(['gemini-cli'] as const);
    expect(pendingHookClients(detected, states, dismissed)).toEqual(['codex']);
  });
  it('client-missing은 제외', () => {
    const states = new Map([['claude-code', 'client-missing'], ['codex', 'not-installed']] as const);
    expect(pendingHookClients(new Set(['claude-code', 'codex'] as const), states, new Set())).toEqual(['codex']);
  });
});
```

> `pendingHookClients`가 테스트되려면 `extension.ts`에서 export돼야 한다. vscode를 import하는 파일이지만, 이 함수는 vscode 비의존 순수 함수라 export만 하면 테스트에서 import 가능(vscode 심볼을 실행 경로에서 만지지 않음). 만약 import가 vscode 로드를 유발하면 이 함수를 `packages/extension/src/nudge.ts`로 분리하고 거기서 테스트한다.

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Implement** — `extension.ts`(또는 `nudge.ts`)에 순수 함수 추가.

```ts
import type { HookClient, InstallState } from './hookInstall.js';

export function pendingHookClients(
  detected: ReadonlySet<HookClient>,
  states: ReadonlyMap<HookClient, InstallState>,
  dismissed: ReadonlySet<HookClient>,
): HookClient[] {
  return [...detected].filter((c) =>
    states.get(c) === 'not-installed' && !dismissed.has(c));
}
```

- [ ] **Step 4: Wire installers + commands + nudge** — `extension.ts` 통합.

설치기 맵을 만든다:
```ts
function installerFor(client: HookClient): ClientHookInstaller {
  const deps: InstallerDeps = {
    home: require('node:os').homedir(),
    findBinary, run: runBin, fs: nodeFs,
    bundledDir: path.join(__dirname,
      client === 'claude-code' ? 'claude-marketplace'
      : client === 'codex' ? 'codex-marketplace' : 'gemini-extension'),
  };
  return client === 'claude-code' ? new ClaudeHookInstaller(deps)
    : client === 'codex' ? new CodexHookInstaller(deps)
    : new GeminiHookInstaller(deps);
}
```

트리 갱신을 `refresh()` 안에 추가(각 설치기 `detect()` + `collectionHealthByClient()` 조인):
```ts
async function refreshCollection() {
  const detected = detectClients().filter((c) => c.installed).map((c) => c.client);
  const byHealth = (store as any).collectionHealthByClient?.() ?? new Map();
  const inputs = await Promise.all(detected.map(async (client) => ({
    client, install: await installerFor(client).detect(),
    snapshot: byHealth.get(client),
  })));
  hookStatusProvider.setClients(inputs);
  return inputs;
}
```

설치/제거 커맨드(제네릭, 노드의 `id`=client 사용):
```ts
vscode.commands.registerCommand('mcp-lens.installHooks', async (node?: { client?: HookClient }) => {
  const client = node?.client; if (!client) return;
  const r = await installerFor(client).install();
  if (r.kind === 'client-missing') void vscode.window.showWarningMessage(`MCP Lens: ${client} CLI를 찾을 수 없습니다.`);
  else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} 훅 설치 실패 (${r.step}): ${r.stderr.slice(0, 300)}`);
  else void vscode.window.showInformationMessage(`MCP Lens: ${client} 훅 설치 완료 — 새 세션부터 수집이 시작됩니다.`);
  await refreshCollection();
}),
vscode.commands.registerCommand('mcp-lens.uninstallHooks', async (node?: { client?: HookClient }) => {
  const client = node?.client; if (!client) return;
  const r = await installerFor(client).uninstall();
  if (r.kind === 'ok') void vscode.window.showInformationMessage(`MCP Lens: ${client} 훅을 제거했습니다.`);
  else if (r.kind === 'failed') void vscode.window.showErrorMessage(`MCP Lens ${client} 훅 제거 실패: ${r.stderr.slice(0, 300)}`);
  await refreshCollection();
}),
```

통합 넛지(기존 Claude 전용 IIFE 교체, per-client dismiss):
```ts
void (async () => {
  const inputs = await refreshCollection();
  const detected = new Set(inputs.map((i) => i.client));
  const states = new Map(inputs.map((i) => [i.client, i.install] as const));
  const dismissed = new Set<HookClient>(
    (['claude-code', 'codex', 'gemini-cli'] as HookClient[])
      .filter((c) => ctx.globalState.get<boolean>(`${DISMISS_KEY}.${c}`)));
  const pending = pendingHookClients(detected, states, dismissed);
  if (pending.length === 0) return;
  const choice = await vscode.window.showInformationMessage(
    `MCP Lens: ${pending.join('·')} 훅 수집이 꺼져 있어요`, '모두 설치', '수집 뷰 열기', '다시 안 보기');
  if (choice === '모두 설치') { for (const c of pending) await installerFor(c).install(); await refreshCollection(); }
  else if (choice === '수집 뷰 열기') void vscode.commands.executeCommand('mcpLens.collection.focus');
  else if (choice === '다시 안 보기') for (const c of pending) await ctx.globalState.update(`${DISMISS_KEY}.${c}`, true);
})();
```

기존 `mcp-lens.installClaudeHooks`/`uninstallClaudeHooks` 커맨드와 Claude 전용 IIFE·`runInstallFlow`·`hookDeps`·`detectClaudeHookInstall` 호출은 제거하고 위 제네릭 경로로 대체한다. `hooksDoctor`는 `refreshCollection()`의 최근 결과를 요약하도록 조정(또는 유지하되 첫 행 기준). 상태바 요약 `healthFor`는 기존 전역 `collectionHealth()` 유지.

- [ ] **Step 5: Run tests + build** — `npx vitest run packages/extension` PASS, `npm --prefix packages/extension run build && npm --prefix packages/extension run typecheck` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/extension.ts packages/extension/test/nudge.test.ts
git commit -m "feat(extension): 3-클라이언트 설치기 배선·설치/제거 커맨드·통합 넛지(per-client dismiss)"
```

---

### Task C4: package.json 기여점 (커맨드 + 컨텍스트 메뉴)

**Files:**
- Modify: `packages/extension/package.json` (`contributes.commands`, `contributes.menus`)

**Interfaces:**
- Consumes: 커맨드 id `mcp-lens.installHooks`·`mcp-lens.uninstallHooks` (C3), contextValue `hook-installable`·`hook-installed` (C2).

- [ ] **Step 1: 커맨드 등록** — `contributes.commands`에 추가.

```json
{ "command": "mcp-lens.installHooks", "title": "MCP Lens: 이 클라이언트에 훅 설치" },
{ "command": "mcp-lens.uninstallHooks", "title": "MCP Lens: 이 클라이언트 훅 제거" }
```

- [ ] **Step 2: 컨텍스트 메뉴 라우팅** — `contributes.menus."view/item/context"`에 추가(수집 뷰 행 대상).

```json
{ "command": "mcp-lens.installHooks", "when": "view == mcpLens.collection && viewItem == hook-installable", "group": "inline" },
{ "command": "mcp-lens.uninstallHooks", "when": "view == mcpLens.collection && viewItem == hook-installed", "group": "1_actions" }
```

- [ ] **Step 3: commandPalette 숨김(선택)** — 노드 인자가 필요한 커맨드는 팔레트에서 숨긴다.

```json
{ "command": "mcp-lens.installHooks", "when": "false" },
{ "command": "mcp-lens.uninstallHooks", "when": "false" }
```
(`contributes.menus.commandPalette`에 추가)

- [ ] **Step 4: Validate** — Run: `node -e "JSON.parse(require('fs').readFileSync('packages/extension/package.json','utf8')); console.log('json ok')"`. Expected: `json ok`. 이어 `npm --prefix packages/extension run build` PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/package.json
git commit -m "feat(extension): 수집 뷰 설치/제거 컨텍스트 메뉴 기여점"
```

---

## Self-Review 결과

- **Spec 커버리지**: §4 설치기·번들(B1–B4·C4), §5.1 per-client 건강도(A1), §5.2 상태 합성(C1), §5.3 트리 렌더(C2), §6 UX·넛지·에러(C3·C4). §5.4 게이트는 "범위 밖"에 명시 분리. 커버 완료.
- **플레이스홀더**: 코드 스텝은 실제 코드 포함. B2·B3의 codex 마켓플레이스/gemini 항목 스키마는 실측 불확정분이라 "연구 단계"로 실제 참조 파일 경로를 지정(픽스처는 실측값으로 채움) — opus 어댑터 태스크로 배정.
- **타입 일관성**: `InstallState`/`InstallResult`/`InstallerDeps`/`ClientHookInstaller`/`HookClient`가 B1에서 정의되고 B2·B3·C1·C2·C3에서 동일 이름으로 소비. `collectionHealthByClient()`는 A1 생산 → C3 소비. `clientRowPresentation`(C1)→`toRow`(C2)→`setClients`(C3). `pendingHookClients`(C3) 순수. 일치.
