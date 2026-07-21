# Claude Code 훅 자동 설치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code 확장이 시작 시 1회 알림 → 클릭으로 Claude Code 훅 플러그인을 공식 `claude` CLI로 설치하게 한다(사용자 설정 편집 0).

**Architecture:** 순수 오케스트레이션(`hookInstall.ts`, vscode·child_process import 없음, 의존성 주입)과 실제 부수효과 계층(`claudeCli.ts`)을 분리하고, `extension.ts`는 배선만 담당한다. 번들 플러그인은 esbuild가 `dist/claude-marketplace/`로 복사하고, 설치 시 안정 경로 `~/.mcplens/claude-marketplace/`로 옮겨 `claude plugin marketplace add` → `claude plugin install`을 실행한다.

**Tech Stack:** TypeScript strict, Node ≥20, VS Code Extension API, esbuild(cjs), vitest. 새 dependency 없음.

설계 근거: `docs/superpowers/specs/2026-07-21-claude-hook-auto-install-design.md`. 수동 검증 기록: `docs/SMOKE.md` "Claude Code 실기기 검증".

## Global Constraints

- `hookInstall.ts`는 `vscode`·`node:child_process`·`node:fs`를 직접 import하지 않는다(전부 주입). 유닛 테스트는 fake 주입만 사용.
- 새 npm dependency·네이티브 애드온 추가 금지.
- `claude` 미탐색·설치 실패는 throw하지 않고 결과 객체로 반환한다(fail-open). activate와 로그 수집은 절대 중단되지 않는다.
- 대상은 Claude Code 전용. Codex/Gemini는 비목표.
- 마켓플레이스 이름 `mcplens`, 플러그인 설치 식별자 `mcp-lens@mcplens` (정확히 이 문자열).
- **사용자 미커밋 변경 보존:** main 워킹트리에 `packages/extension/esbuild.mjs`와 `packages/extension/scripts/bundle-smoke.mjs`의 커밋되지 않은 사용자 변경이 있다. Task 2는 착수 전 `git -C <worktree> diff` 상태를 확인하고, 병합 시 이 변경을 삭제·되돌리지 말고 보존·재조정한다.
- 원본 클라이언트 로그는 읽기 전용. raw tool input/output·비밀 값 저장 금지(런너가 이미 레댁션).

---

## Terminal Schedule (병렬 배분)

터미널 1개 = worktree 1개 = 브랜치 1개. 오케스트레이터 세션(opus)이 각 태스크마다 서브에이전트를 스폰하고 사이사이 리뷰·머지한다.

| Wave | 터미널 | Task | 브랜치 / worktree | 파일 소유 | 병렬 규칙 |
|---|---|---|---|---|---|
| 1 | T1 | **Task 1** 설치 로직 | `feat/hook-install-logic` @ `/private/tmp/mcplens-hi-logic` | `hookInstall.ts`, `hookInstall.test.ts` | Task 2와 **파일 완전 분리 → 병렬 가능** |
| 1 | T2 | **Task 2** 번들링 | `feat/hook-install-bundling` @ `/private/tmp/mcplens-hi-bundle` | `esbuild.mjs`, `assets/claude-marketplace.json` | Task 1과 병렬 (package.json 안 건드림) |
| 2 | T1 | **Task 3** 확장 배선 | `feat/hook-install-wiring` @ `/private/tmp/mcplens-hi-wiring` (main←1,2 병합 후 분기) | `extension.ts`, `claudeCli.ts`, `package.json`(contributes.commands) | Task 1 API + Task 2 번들 경로에 **의존 → 순차** |
| 3 | T1 | **Task 4** 실기기 스모크·문서 | `feat/hook-install-smoke` | `docs/SMOKE.md` | 실기기 직렬 |

모델 배분(서브에이전트 `model` 파라미터): Task 1·2·3 = **sonnet**(사양·코드 명확), Task 4 = **opus**(실기기 디버깅 예외). 오케스트레이터 세션 = opus.

Wave 1 병렬 착수 명령(오케스트레이터가 worktree 준비):

```bash
cd /Users/doo._.hyun/Study/Project/MCPLens
git worktree add /private/tmp/mcplens-hi-logic  -b feat/hook-install-logic  main
git worktree add /private/tmp/mcplens-hi-bundle -b feat/hook-install-bundling main
```

각 터미널에서 해당 worktree를 대상으로 서브에이전트를 스폰해 Task를 구현한다. Wave 1 두 브랜치가 테스트·커밋되면 main에 순서 무관 병합(파일 분리라 충돌 없음) 후 Wave 2를 분기한다.

---

## File Map

```text
packages/extension/
  src/hookInstall.ts        # Task 1: 순수 설치 오케스트레이션 (주입 의존성)
  test/hookInstall.test.ts  # Task 1
  src/claudeCli.ts          # Task 3: 실제 spawn/fs 계층 (findClaudeBinary, runClaude, nodeFs)
  src/extension.ts          # Task 3: activate 배선 (알림 + 명령)
  package.json              # Task 3: contributes.commands 2개
  esbuild.mjs               # Task 2: dist/claude-marketplace 복사
  assets/claude-marketplace.json  # Task 2: 마켓플레이스 매니페스트 (신규)
docs/SMOKE.md               # Task 4
```

런타임 데이터 흐름: `esbuild` → `dist/claude-marketplace/{.claude-plugin/marketplace.json, mcp-lens/...}` → 설치 시 `~/.mcplens/claude-marketplace/`로 copy → `claude plugin marketplace add` → `claude plugin install mcp-lens@mcplens` → 새 세션에서 훅 발화 → `~/.mcplens/inbox`.

---

### Task 1: 설치 오케스트레이션 로직 (순수)

**Files:**
- Create: `packages/extension/src/hookInstall.ts`
- Test: `packages/extension/test/hookInstall.test.ts`

**Interfaces:**
- Produces: `HookInstallDeps`, `RunResult`, `InstallState`(`'installed'|'not-installed'|'claude-missing'`), `InstallResult`, `MARKETPLACE_NAME`, `PLUGIN_ID`, `stableMarketplaceDir(home)`, `detectClaudeHookInstall(deps): Promise<InstallState>`, `installClaudeHooks(deps): Promise<InstallResult>`, `uninstallClaudeHooks(deps): Promise<InstallResult>`.
- Consumes: 없음(전부 주입). 설계의 동기 `detectClaudeHookInstall`은 `claude plugin list` 조회 때문에 **async로 정정**한다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// packages/extension/test/hookInstall.test.ts
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  detectClaudeHookInstall, installClaudeHooks, uninstallClaudeHooks,
  stableMarketplaceDir, PLUGIN_ID, MARKETPLACE_NAME,
  type HookInstallDeps, type RunResult,
} from '../src/hookInstall.js';

const HOME = '/home/u';
function deps(over: Partial<HookInstallDeps> = {}): HookInstallDeps {
  return {
    home: HOME,
    findClaudeBinary: () => '/bin/claude',
    runClaude: async () => ({ stdout: '', stderr: '', code: 0 }),
    fs: { copyDir: vi.fn(), exists: () => false, readDir: () => [] },
    bundledMarketplaceDir: '/ext/dist/claude-marketplace',
    ...over,
  };
}

describe('installClaudeHooks', () => {
  it('installs via marketplace add then plugin install when absent', async () => {
    const calls: string[][] = [];
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[1] === 'list') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const copyDir = vi.fn();
    const result = await installClaudeHooks(deps({ runClaude, fs: { copyDir, exists: () => false, readDir: () => [] } }));

    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(copyDir).toHaveBeenCalledWith('/ext/dist/claude-marketplace', stableMarketplaceDir(HOME));
    expect(calls).toContainEqual(['plugin', 'marketplace', 'add', stableMarketplaceDir(HOME)]);
    expect(calls).toContainEqual(['plugin', 'install', PLUGIN_ID]);
  });

  it('skips install when plugin list already reports it installed', async () => {
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> =>
      args[1] === 'list'
        ? { stdout: `${PLUGIN_ID}  installed, enabled  0.1.0`, stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 });
    const result = await installClaudeHooks(deps({ runClaude }));

    expect(result).toEqual({ kind: 'ok', alreadyInstalled: true });
    expect(runClaude).not.toHaveBeenCalledWith(['plugin', 'install', PLUGIN_ID]);
  });

  it('returns claude-missing without running anything', async () => {
    const runClaude = vi.fn(async (): Promise<RunResult> => ({ stdout: '', stderr: '', code: 0 }));
    const result = await installClaudeHooks(deps({ findClaudeBinary: () => null, runClaude }));
    expect(result).toEqual({ kind: 'claude-missing' });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('reports failure with the step and stderr on non-zero install', async () => {
    const runClaude = async (args: string[]): Promise<RunResult> =>
      args[1] === 'install'
        ? { stdout: '', stderr: 'boom', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const result = await installClaudeHooks(deps({ runClaude }));
    expect(result).toEqual({ kind: 'failed', step: 'install', stderr: 'boom' });
  });

  it('treats an already-existing marketplace as success', async () => {
    const runClaude = async (args: string[]): Promise<RunResult> =>
      args[2] === 'add'
        ? { stdout: '', stderr: 'marketplace already exists', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    const result = await installClaudeHooks(deps({ runClaude }));
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
  });
});

describe('detectClaudeHookInstall', () => {
  it('falls back to the cache-glob when plugin list is unavailable', async () => {
    const cache = join(HOME, '.claude', 'plugins', 'cache');
    const runner = join(cache, 'mcplens', 'mcp-lens', '0.1.0', 'scripts', 'hook-runner.mjs');
    const state = await detectClaudeHookInstall(deps({
      runClaude: async () => ({ stdout: '', stderr: 'err', code: 1 }),
      fs: {
        copyDir: () => {}, exists: (p) => p === runner,
        readDir: (p) => {
          if (p === cache) return ['mcplens'];
          if (p === join(cache, 'mcplens', 'mcp-lens')) return ['0.1.0'];
          return [];
        },
      },
    }));
    expect(state).toBe('installed');
  });
});

describe('uninstallClaudeHooks', () => {
  it('uninstalls the plugin then removes the marketplace', async () => {
    const calls: string[][] = [];
    const runClaude = vi.fn(async (args: string[]): Promise<RunResult> => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; });
    const result = await uninstallClaudeHooks(deps({ runClaude }));
    expect(result).toEqual({ kind: 'ok', alreadyInstalled: false });
    expect(calls[0]).toEqual(['plugin', 'uninstall', PLUGIN_ID]);
    expect(calls[1]).toEqual(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /private/tmp/mcplens-hi-logic && npx vitest run packages/extension/test/hookInstall.test.ts`
Expected: FAIL — `hookInstall.js` 모듈 없음.

- [ ] **Step 3: 최소 구현**

```ts
// packages/extension/src/hookInstall.ts
import { join } from 'node:path';

export interface RunResult { stdout: string; stderr: string; code: number; }

export interface HookInstallDeps {
  home: string;
  findClaudeBinary: () => string | null;
  runClaude: (args: string[]) => Promise<RunResult>;
  fs: {
    copyDir: (from: string, to: string) => void;
    exists: (path: string) => boolean;
    readDir: (path: string) => string[];
  };
  bundledMarketplaceDir: string;
}

export const MARKETPLACE_NAME = 'mcplens';
export const PLUGIN_ID = 'mcp-lens@mcplens';

export type InstallState = 'installed' | 'not-installed' | 'claude-missing';

export type InstallResult =
  | { kind: 'ok'; alreadyInstalled: boolean }
  | { kind: 'claude-missing' }
  | { kind: 'failed'; step: string; stderr: string };

export function stableMarketplaceDir(home: string): string {
  return join(home, '.mcplens', 'claude-marketplace');
}

export async function detectClaudeHookInstall(deps: HookInstallDeps): Promise<InstallState> {
  if (deps.findClaudeBinary() === null) return 'claude-missing';
  try {
    const r = await deps.runClaude(['plugin', 'list']);
    if (r.code === 0 && pluginListReportsInstalled(r.stdout)) return 'installed';
  } catch {
    // fall through to the filesystem cache check
  }
  return hasCachedRunner(deps) ? 'installed' : 'not-installed';
}

export async function installClaudeHooks(deps: HookInstallDeps): Promise<InstallResult> {
  const state = await detectClaudeHookInstall(deps);
  if (state === 'claude-missing') return { kind: 'claude-missing' };
  if (state === 'installed') return { kind: 'ok', alreadyInstalled: true };

  const target = stableMarketplaceDir(deps.home);
  deps.fs.copyDir(deps.bundledMarketplaceDir, target);

  const add = await deps.runClaude(['plugin', 'marketplace', 'add', target]);
  if (add.code !== 0 && !isAlreadyPresent(add.stderr)) {
    return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
  }
  const install = await deps.runClaude(['plugin', 'install', PLUGIN_ID]);
  if (install.code !== 0 && !isAlreadyPresent(install.stderr)) {
    return { kind: 'failed', step: 'install', stderr: install.stderr };
  }
  return { kind: 'ok', alreadyInstalled: false };
}

export async function uninstallClaudeHooks(deps: HookInstallDeps): Promise<InstallResult> {
  if (deps.findClaudeBinary() === null) return { kind: 'claude-missing' };
  const uninstall = await deps.runClaude(['plugin', 'uninstall', PLUGIN_ID]);
  if (uninstall.code !== 0 && !/not installed|no such/i.test(uninstall.stderr)) {
    return { kind: 'failed', step: 'uninstall', stderr: uninstall.stderr };
  }
  await deps.runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  return { kind: 'ok', alreadyInstalled: false };
}

function pluginListReportsInstalled(stdout: string): boolean {
  return stdout.split('\n').some((line) => line.includes(PLUGIN_ID) && /\binstalled\b/.test(line));
}

function hasCachedRunner(deps: HookInstallDeps): boolean {
  const cacheRoot = join(deps.home, '.claude', 'plugins', 'cache');
  for (const marketplace of safeReadDir(deps, cacheRoot)) {
    const pluginDir = join(cacheRoot, marketplace, 'mcp-lens');
    for (const version of safeReadDir(deps, pluginDir)) {
      if (deps.fs.exists(join(pluginDir, version, 'scripts', 'hook-runner.mjs'))) return true;
    }
  }
  return false;
}

function safeReadDir(deps: HookInstallDeps, dir: string): string[] {
  try { return deps.fs.readDir(dir); } catch { return []; }
}

function isAlreadyPresent(stderr: string): boolean {
  return /already (exists|added|installed)/i.test(stderr);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run packages/extension/test/hookInstall.test.ts`
Expected: PASS (8 테스트).

- [ ] **Step 5: 커밋**

```bash
git add packages/extension/src/hookInstall.ts packages/extension/test/hookInstall.test.ts
git commit -m "feat(extension): add claude hook install orchestration"
```

---

### Task 2: 플러그인 번들링 + 마켓플레이스 에셋

**Files:**
- Create: `packages/extension/assets/claude-marketplace.json`
- Modify: `packages/extension/esbuild.mjs`

**Interfaces:**
- Produces: 빌드 산출물 `dist/claude-marketplace/.claude-plugin/marketplace.json`, `dist/claude-marketplace/mcp-lens/scripts/hook-runner.mjs`(+`runtime/`,`hooks/`,`.claude-plugin/`,`commands/`). 런타임에서 `join(__dirname, 'claude-marketplace')`로 참조된다(Task 3).
- Consumes: 소스 플러그인 `packages/lens-audit-plugin/`(H11 산출, runtime byte-identical 보장).

**주의:** 착수 전 `git -C /private/tmp/mcplens-hi-bundle status`로 `esbuild.mjs`가 base(main HEAD) 상태인지 확인한다. main 워킹트리의 미커밋 사용자 변경은 이 worktree에 없다 — 병합 시 오케스트레이터가 사용자 변경과 재조정한다(삭제 금지).

- [ ] **Step 1: 마켓플레이스 매니페스트 생성**

```json
// packages/extension/assets/claude-marketplace.json
{
  "name": "mcplens",
  "owner": { "name": "MCP Lens", "email": "" },
  "metadata": { "description": "MCP Lens local hook collection", "version": "0.1.0" },
  "plugins": [
    {
      "name": "mcp-lens",
      "source": "./mcp-lens",
      "description": "Local MCP context accounting with self-contained lifecycle hooks",
      "category": "monitoring",
      "tags": ["mcp", "hooks", "accounting"]
    }
  ],
  "version": "0.1.0"
}
```

- [ ] **Step 2: esbuild에 복사 단계 추가**

`esbuild.mjs`의 번들 완료 직후(schema.sql·wasm 복사 부근)에 아래를 추가한다. 기존 코드·사용자 변경은 보존하고 이 블록만 삽입:

```js
import { cpSync, mkdirSync } from 'node:fs';
// ... 기존 build 완료 이후 ...
const marketplaceRoot = 'dist/claude-marketplace';
mkdirSync(`${marketplaceRoot}/.claude-plugin`, { recursive: true });
cpSync('assets/claude-marketplace.json', `${marketplaceRoot}/.claude-plugin/marketplace.json`);
cpSync('../lens-audit-plugin', `${marketplaceRoot}/mcp-lens`, {
  recursive: true,
  filter: (src) => !src.includes(`${'/'}node_modules${'/'}`),
});
console.log('[esbuild] bundled dist/claude-marketplace (Claude hook plugin)');
```

- [ ] **Step 3: 빌드 후 산출물 검증**

Run:
```bash
cd /private/tmp/mcplens-hi-bundle
npm run build -w mcp-lens
test -f packages/extension/dist/claude-marketplace/.claude-plugin/marketplace.json && \
test -f packages/extension/dist/claude-marketplace/mcp-lens/scripts/hook-runner.mjs && \
test -f packages/extension/dist/claude-marketplace/mcp-lens/runtime/hook-capture.mjs && echo "BUNDLE OK"
```
Expected: `BUNDLE OK` 출력, `node_modules` 미포함.

- [ ] **Step 4: 커밋**

```bash
git add packages/extension/assets/claude-marketplace.json packages/extension/esbuild.mjs
git commit -m "build(extension): bundle claude hook marketplace into dist"
```

---

### Task 3: 확장 배선 (알림 + 명령 + 실제 deps)

**전제:** Task 1·2가 main에 병합된 후 `git worktree add /private/tmp/mcplens-hi-wiring -b feat/hook-install-wiring main`로 분기.

**Files:**
- Create: `packages/extension/src/claudeCli.ts`
- Modify: `packages/extension/src/extension.ts`
- Modify: `packages/extension/package.json` (contributes.commands)

**Interfaces:**
- Consumes: `hookInstall.ts`의 `installClaudeHooks`, `uninstallClaudeHooks`, `detectClaudeHookInstall`, `HookInstallDeps`; `claudeCli.ts`의 `findClaudeBinary`, `runClaude`, `nodeFs`.
- Produces: 명령 `mcp-lens.installClaudeHooks`, `mcp-lens.uninstallClaudeHooks`; activate 알림 트리거.

- [ ] **Step 1: 실제 deps 계층 작성 + 테스트**

```ts
// packages/extension/src/claudeCli.ts
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from './hookInstall.js';

const CANDIDATES = (): string[] => [
  join(homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

export function findClaudeBinary(): string | null {
  for (const candidate of CANDIDATES()) if (existsSync(candidate)) return candidate;
  const onPath = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return onPath.status === 0 ? 'claude' : null;
}

export function runClaude(bin: string, args: string[]): Promise<RunResult> {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 });
}

export const nodeFs = {
  copyDir: (from: string, to: string) => cpSync(from, to, { recursive: true }),
  exists: (path: string) => existsSync(path),
  readDir: (path: string) => readdirSync(path),
};
```

```ts
// packages/extension/test/claudeCli.test.ts
import { describe, expect, it } from 'vitest';
import { findClaudeBinary } from '../src/claudeCli.js';

describe('findClaudeBinary', () => {
  it('returns null or a string without throwing', () => {
    const result = findClaudeBinary();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 통과 확인**

Run: `cd /private/tmp/mcplens-hi-wiring && npx vitest run packages/extension/test/claudeCli.test.ts`
Expected: PASS.

- [ ] **Step 3: package.json에 명령 등록**

`packages/extension/package.json`의 `contributes.commands` 배열에 추가(기존 항목 보존):

```json
{ "command": "mcp-lens.installClaudeHooks", "title": "MCP Lens: Install Claude hooks" },
{ "command": "mcp-lens.uninstallClaudeHooks", "title": "MCP Lens: Uninstall Claude hooks" }
```

- [ ] **Step 4: extension.ts 배선**

`extension.ts` import에 추가:

```ts
import { detectClaudeHookInstall, installClaudeHooks, uninstallClaudeHooks, type HookInstallDeps } from './hookInstall.js';
import { findClaudeBinary, runClaude, nodeFs } from './claudeCli.js';
```

`activate(ctx)` 안, 헬퍼 정의:

```ts
const DISMISS_KEY = 'mcpLens.hookInstall.dismissed';
function hookDeps(): HookInstallDeps {
  const bin = findClaudeBinary();
  return {
    home: require('node:os').homedir(),
    findClaudeBinary,
    runClaude: (args) => runClaude(bin ?? 'claude', args),
    fs: nodeFs,
    bundledMarketplaceDir: join(__dirname, 'claude-marketplace'),
  };
}
async function runInstallFlow() {
  const result = await installClaudeHooks(hookDeps());
  if (result.kind === 'claude-missing') {
    void vscode.window.showWarningMessage('MCP Lens: claude CLI를 찾을 수 없어 훅을 설치할 수 없습니다. Claude Code 설치를 확인하세요.');
  } else if (result.kind === 'failed') {
    void vscode.window.showErrorMessage(`MCP Lens 훅 설치 실패 (${result.step}): ${result.stderr.slice(0, 300)}`);
  } else if (result.alreadyInstalled) {
    void vscode.window.showInformationMessage('MCP Lens: Claude 훅이 이미 설치되어 있습니다.');
  } else {
    void vscode.window.showInformationMessage('MCP Lens: 훅 설치 완료 — 새 Claude 세션을 시작하면 수집이 시작됩니다.');
  }
}
```

명령 등록(기존 `ctx.subscriptions.push(...)` 블록에 추가):

```ts
vscode.commands.registerCommand('mcp-lens.installClaudeHooks', () => runInstallFlow()),
vscode.commands.registerCommand('mcp-lens.uninstallClaudeHooks', async () => {
  const result = await uninstallClaudeHooks(hookDeps());
  if (result.kind === 'ok') void vscode.window.showInformationMessage('MCP Lens: Claude 훅을 제거했습니다.');
  else if (result.kind === 'claude-missing') void vscode.window.showWarningMessage('MCP Lens: claude CLI를 찾을 수 없습니다.');
  else void vscode.window.showErrorMessage(`MCP Lens 훅 제거 실패: ${result.stderr.slice(0, 300)}`);
}),
```

시작 시 1회 알림(activate 끝부분, `watcher.start()` 이후):

```ts
void (async () => {
  if (ctx.globalState.get<boolean>(DISMISS_KEY)) return;
  if (!detectClients().some((c) => c.client === 'claude-code' && c.installed)) return;
  if (await detectClaudeHookInstall(hookDeps()) !== 'not-installed') return;
  const choice = await vscode.window.showInformationMessage(
    'MCP Lens: Claude Code 훅 수집을 켜시겠어요? (설정 편집 없이 설치됩니다)',
    '설치', '나중에', '다시 안 보기');
  if (choice === '설치') await runInstallFlow();
  else if (choice === '다시 안 보기') await ctx.globalState.update(DISMISS_KEY, true);
})();
```

- [ ] **Step 5: typecheck·build·smoke**

Run:
```bash
cd /private/tmp/mcplens-hi-wiring
npx vitest run packages/extension/test
npm run typecheck -w mcp-lens
npm run build -w mcp-lens
npm run smoke -w mcp-lens
```
Expected: 전부 통과, `dist/claude-marketplace/` 산출.

- [ ] **Step 6: 커밋**

```bash
git add packages/extension/src/claudeCli.ts packages/extension/test/claudeCli.test.ts packages/extension/src/extension.ts packages/extension/package.json
git commit -m "feat(extension): notify and install claude hooks on activation"
```

---

### Task 4: 실기기 스모크 + 문서 (직렬, opus)

**전제:** Task 1·2·3 병합 + 통합 게이트(`npm test && npm run build && npm run typecheck -w mcp-lens && npm run smoke -w mcp-lens`) 통과 후.

**Files:**
- Modify: `docs/SMOKE.md`

- [ ] **Step 1: 확장 dev 호스트로 알림→설치 검증**

기존에 설치된 수동 플러그인/마켓플레이스가 있으면 먼저 제거해 `not-installed` 상태를 만든다:

```bash
claude plugin uninstall mcp-lens@mcplens-local 2>/dev/null; claude plugin marketplace remove mcplens-local 2>/dev/null
```

VS Code에서 F5(확장 개발 호스트) 실행 → 시작 알림 확인 → **[설치]** 클릭 → "설치 완료" 알림 확인. `claude plugin list`에 `mcp-lens@mcplens installed` 노출 확인.

- [ ] **Step 2: 실발화 검증**

새 Claude Code 세션 시작 → MCP 툴 1회 호출 → `ls ~/.mcplens/inbox/pending/`에 `claude-code` 봉투 생성 확인. 봉투에 `tool_input`/`tool_response` 없음(레댁션) 확인.

- [ ] **Step 3: 멱등·제거 검증**

확장 재시작 시 알림이 다시 안 뜸(이미 설치) 확인. `MCP Lens: Uninstall Claude hooks` 명령 → `claude plugin list`에서 제거 확인.

- [ ] **Step 4: SMOKE.md 기록**

`docs/SMOKE.md`에 "확장 자동 설치(H-autoinstall) 검증" 섹션 추가: 알림 표시·[설치]→설치·새 세션 실발화·멱등·제거 결과와, 자동화 불가 단계(새 세션 시작)를 명시.

- [ ] **Step 5: 커밋**

```bash
git add docs/SMOKE.md
git commit -m "docs: record claude hook auto-install smoke"
```

---

## Self-Review

- **Spec coverage:** 방식 A(claude CLI)→Task1·3, 알림 1회 트리거→Task3 Step4, 번들/안정경로→Task2+Task1 `stableMarketplaceDir`, 멱등·감지→Task1 `detectClaudeHookInstall`, 명령 2개→Task3, fail-open→Task1 결과객체+Task3 알림, 테스트→Task1(8)+Task3, 실기기 스모크→Task4. 전 항목 태스크 매핑됨.
- **Placeholder scan:** 코드 단계 전부 완전 코드. "적절한 에러 처리" 류 없음.
- **Type consistency:** `HookInstallDeps`/`RunResult`/`InstallResult`/`PLUGIN_ID`/`MARKETPLACE_NAME`/`stableMarketplaceDir`가 Task1 정의와 Task3 소비에서 동일. `detectClaudeHookInstall`는 async로 통일(spec의 동기 표기 정정, 본 계획 Task1 Interfaces에 명시).
- **정정 기록:** spec의 동기 `detectClaudeHookInstall`을 `Promise<InstallState>`로 변경(claude plugin list 조회 필요). InstallState를 `{kind}` 객체 대신 문자열 유니온으로 단순화.
