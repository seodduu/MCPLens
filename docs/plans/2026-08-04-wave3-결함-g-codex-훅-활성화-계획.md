# Wave 3 결함 G 보정 구현 계획 — codex 훅 활성화와 승인 대기 상태

"첫 설치 사용자" 재현 실험에서, 사용자가 "모두 설치"를 눌러도 codex 훅이 **하나도 실행되지 않는데
확장은 설치 성공으로 보고하고 배너를 지우는** 결함이 드러났다. 조용한 거짓 성공이다.

기점 커밋은 이 계획서를 커밋한 시점의 HEAD다.

## 관측된 사실

codex가 훅을 실행하려면 `~/.codex/config.toml`의 `[hooks.state."<키>"]`에 **두 가지가 모두** 있어야
한다. 실측으로 확정했다.

| config 상태 | 훅 실행 |
|---|---|
| 섹션 자체가 없음 (진짜 첫 설치) | ❌ 안 됨. codex가 섹션을 자동 생성하지도 않는다 |
| `enabled = true`만 | ❌ 안 됨 |
| `trusted_hash`만 | ❌ 안 됨 |
| `enabled = true` + `trusted_hash` | ✅ 실행됨 |

훅 키 형식은 `<pluginId>:hooks/hooks.json:<이벤트>:<그룹인덱스>:<훅인덱스>`이고, 우리 번들
`hooks.json`은 이벤트마다 그룹 1개·훅 1개이므로 인덱스는 항상 `0:0`이다.

```
mcp-lens@mcplens:hooks/hooks.json:pre_tool_use:0:0
mcp-lens@mcplens:hooks/hooks.json:post_tool_use:0:0
mcp-lens@mcplens:hooks/hooks.json:session_start:0:0
mcp-lens@mcplens:hooks/hooks.json:stop:0:0
```

현재 `CodexHookInstaller.install()`은 디렉터리 복사 → `plugin marketplace add` → `plugin add`만
한다. **`hooks.state`를 전혀 건드리지 않는다.** `detect()`도 `codex plugin list --json`으로 플러그인
설치 여부만 본다. 그래서 설치는 성공하고 배너는 사라지지만 훅은 한 번도 돌지 않는다.

## 설계 판단: `enabled`는 우리가 쓰고, `trusted_hash`는 사용자가 승인한다

두 값의 성격이 다르다.

- **`enabled = true`는 사용자 토글이다.** 사용자가 "모두 설치"를 눌러 명시적으로 동의했고, 우리
  플러그인의 훅에만 해당한다. 확장이 쓰는 것이 사용자 의도에 부합한다. 버튼을 눌렀는데 아무것도
  안 켜지는 현재 동작이 오히려 사용자를 배신한다.
- **`trusted_hash`는 "사용자가 이 훅을 검토하고 신뢰했다"는 보안 기록이다.** 훅은 임의 명령을
  실행하므로 codex가 의도적으로 세운 통제다. 값 계산을 시도해 봤으나 재현에 실패했고(명령 문자열,
  이벤트명 조합 등 여러 직렬화 시도가 모두 불일치), 설령 알아내도 codex 내부 구현이라 버전이 바뀌면
  깨진다. **무엇보다 위조해서는 안 된다.** 우리가 대신 "검토했다"고 서명하는 것이 되기 때문이다.

다행히 사용자 부담은 크지 않다. **codex를 실행하면 동의 프롬프트가 자동으로 뜬다**(실측 확인).
`/hooks` 화면을 찾아 들어갈 필요가 없다. 승인하면 codex가 `trusted_hash`를 기록한다.

따라서 흐름은 **"모두 설치" 1회 + codex 실행 시 뜨는 동의 승인 1회**이고, 확장은 그 두 번째 단계가
남았다는 것을 **정확히 표시**해야 한다.

## 변경 1: `InstallState`에 `needs-approval`을 더한다

`packages/extension/src/hookInstall.ts`.

```ts
/**
 * `needs-approval`: 플러그인이 설치되고 `enabled = true`도 기록됐지만 codex의
 * `trusted_hash` 승인이 남은 상태. 훅은 아직 실행되지 않는다. 설치로는 해소할 수
 * 없고 사용자가 codex를 한 번 실행해 뜨는 동의를 승인해야 한다.
 */
export type InstallState = 'installed' | 'needs-approval' | 'not-installed' | 'client-missing';
```

## 변경 2: config.toml에 `enabled = true`를 기록하는 순수 함수

`packages/extension/src/installers/codexHookState.ts`를 새로 만든다. **TOML을 파싱·재직렬화하지
않는다.** 사용자 config의 주석과 서식을 보존해야 하므로 줄 단위로 최소 편집만 한다.

```ts
import { PLUGIN_ID } from '../hookInstall.js';

/** 우리 번들 hooks.json은 이벤트마다 그룹 1개·훅 1개라 인덱스가 항상 0:0이다. */
const HOOK_EVENTS = ['pre_tool_use', 'post_tool_use', 'session_start', 'stop'] as const;

export const CODEX_HOOK_STATE_KEYS: readonly string[] =
  HOOK_EVENTS.map((event) => `${PLUGIN_ID}:hooks/hooks.json:${event}:0:0`);

export interface CodexHookState {
  key: string;
  /** 섹션이 존재하고 `enabled = true`가 있다 */
  enabled: boolean;
  /** 섹션이 존재하고 `trusted_hash = ...`가 있다 — 사용자 승인의 증거 */
  trusted: boolean;
}

function header(key: string): string { return `[hooks.state."${key}"]`; }

/** 헤더 줄 위치와 그 테이블 본문의 끝(다음 테이블 헤더 또는 EOF)을 찾는다. */
function locate(lines: readonly string[], key: string): { start: number; end: number } | null {
  const want = header(key);
  const start = lines.findIndex((line) => line.trim() === want);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) { end = i; break; }
  }
  return { start, end };
}

/** config.toml 원문에서 우리 훅 4개의 상태를 읽는다. */
export function readCodexHookStates(content: string): CodexHookState[] {
  const lines = content.split('\n');
  return CODEX_HOOK_STATE_KEYS.map((key) => {
    const at = locate(lines, key);
    if (at === null) return { key, enabled: false, trusted: false };
    const body = lines.slice(at.start + 1, at.end);
    return {
      key,
      enabled: body.some((line) => /^\s*enabled\s*=\s*true\s*$/.test(line)),
      trusted: body.some((line) => /^\s*trusted_hash\s*=/.test(line)),
    };
  });
}

/**
 * 우리 훅 4개에 `enabled = true`를 보장한 원문을 돌려준다. 이미 켜져 있으면 그대로 둔다.
 *
 * `trusted_hash`는 절대 쓰지 않는다 — 사용자 승인의 증거이므로 위조 대상이 아니다.
 * 섹션이 없으면 파일 끝에 새 테이블로 붙인다. 새 테이블 헤더로 시작하므로 어떤 테이블
 * 뒤에 붙어도 TOML 구조가 깨지지 않는다.
 */
export function withCodexHooksEnabled(content: string): string {
  let lines = content.split('\n');
  for (const key of CODEX_HOOK_STATE_KEYS) {
    const at = locate(lines, key);
    if (at === null) {
      if (lines.length > 0 && lines.at(-1)!.trim() !== '') lines.push('');
      lines.push(header(key), 'enabled = true', '');
      continue;
    }
    const body = lines.slice(at.start + 1, at.end);
    if (body.some((line) => /^\s*enabled\s*=\s*true\s*$/.test(line))) continue;
    // enabled가 없거나 false다 — 기존 enabled 줄을 걷어내고 헤더 바로 아래에 true를 넣는다.
    lines = [
      ...lines.slice(0, at.start + 1),
      'enabled = true',
      ...body.filter((line) => !/^\s*enabled\s*=/.test(line)),
      ...lines.slice(at.end),
    ];
  }
  return lines.join('\n');
}
```

## 변경 3: `CodexHookInstaller`가 `enabled`를 쓰고 승인 여부를 감지한다

`packages/extension/src/installers/codex.ts`.

`detect()`를 아래로 바꾼다.

```ts
  async detect(): Promise<InstallState> {
    const bin = this.bin('codex');
    if (bin === null) return 'client-missing';
    const r = await this.run(bin, ['plugin', 'list', '--json']);
    if (r.code !== 0) return 'not-installed';
    let present = false;
    try {
      const parsed = JSON.parse(r.stdout) as CodexPluginList;
      present = (parsed.installed ?? []).some(
        (p) => p.pluginId === PLUGIN_ID && p.installed !== false);
    } catch { return 'not-installed'; }
    if (!present) return 'not-installed';

    const states = this.readHookStates();
    // config를 못 읽으면 판단 근거가 없다 — fail-open(base.ts의 never-throw 원칙).
    // 여기서 not-installed로 기울면 매 기동마다 재설치를 시도하게 된다.
    if (states === null) return 'installed';
    // enabled가 빠졌으면 설치로 고칠 수 있다 → 설치 대상으로 되돌린다.
    if (!states.every((s) => s.enabled)) return 'not-installed';
    return states.every((s) => s.trusted) ? 'installed' : 'needs-approval';
  }

  /** 읽을 수 없으면 null — 호출자가 fail-open으로 처리한다. */
  private readHookStates(): CodexHookState[] | null {
    try { return readCodexHookStates(this.deps.fs.readFile(this.configPath())); }
    catch { return null; }
  }

  private configPath(): string { return join(this.deps.home, '.codex', 'config.toml'); }
```

`install()`에서 `plugin add` 성공 뒤에 `enabled`를 쓴다. 앞부분의 조기 반환 조건도 바꾼다.

```ts
  async install(): Promise<InstallResult> {
    const bin = this.bin('codex');
    if (bin === null) return { kind: 'client-missing' };
    const before = await this.detect();
    // needs-approval은 설치로 더 나아갈 수 없다 — 남은 것은 사용자 승인뿐이다.
    if (before === 'installed' || before === 'needs-approval') {
      return { kind: 'ok', alreadyInstalled: true };
    }

    const target = stableDir(this.deps.home, 'codex-marketplace');
    try { this.deps.fs.copyDir(this.deps.bundledDir, target); }
    catch (e) { return { kind: 'failed', step: 'copy', stderr: msg(e) }; }

    const add = await this.run(bin, ['plugin', 'marketplace', 'add', target]);
    if (add.code !== 0 && !alreadyPresent(add.stderr)) {
      return { kind: 'failed', step: 'marketplace-add', stderr: add.stderr };
    }
    const ins = await this.run(bin, ['plugin', 'add', PLUGIN_ID]);
    if (ins.code !== 0 && !alreadyPresent(ins.stderr)) {
      return { kind: 'failed', step: 'install', stderr: ins.stderr };
    }
    const enabled = this.enableHooks();
    if (!enabled.ok) return { kind: 'failed', step: 'enable-hooks', stderr: enabled.stderr };
    return { kind: 'ok', alreadyInstalled: false };
  }

  /**
   * config.toml에 `enabled = true`를 기록한다. 쓰기 전에 백업을 남긴다 —
   * 사용자 CLI 설정이므로 되돌릴 근거를 남겨야 한다(저장소의 `.mcplens.bak` 관례).
   */
  private enableHooks(): { ok: true } | { ok: false; stderr: string } {
    const path = this.configPath();
    try {
      const current = this.deps.fs.exists(path) ? this.deps.fs.readFile(path) : '';
      const next = withCodexHooksEnabled(current);
      if (next === current) return { ok: true };
      if (current !== '') this.deps.fs.writeFile(`${path}.mcplens.bak`, current);
      this.deps.fs.writeFile(path, next);
      return { ok: true };
    } catch (e) { return { ok: false, stderr: msg(e) }; }
  }
```

`uninstall()`은 바꾸지 않는다. `plugin remove`가 훅 항목을 어떻게 다루는지 실측하지 않았고,
남은 `enabled = true`는 플러그인이 없으면 무해하다(가리키는 훅이 존재하지 않는다).

## 변경 4: 승인 대기 클라이언트를 골라내는 함수

`packages/extension/src/nudge.ts`에 추가한다. 기존 `pendingHookClients`는 그대로 둔다.

```ts
/**
 * 훅은 켰지만 codex 승인이 남은 클라이언트. 설치 안내와 문구가 달라야 한다 —
 * 여기서 "설치"를 다시 권하면 사용자가 눌러도 아무 변화가 없어 같은 거짓 성공이 반복된다.
 */
export function approvalPendingClients(
  detected: ReadonlySet<HookClient>,
  states: ReadonlyMap<HookClient, InstallState>,
  dismissed: ReadonlySet<HookClient>,
): HookClient[] {
  return [...detected].filter((c) =>
    states.get(c) === 'needs-approval' && !dismissed.has(c));
}
```

## 변경 5: 배너가 승인 대기를 알린다

`packages/extension/src/extension.ts:402-416`의 IIFE를 아래 구조로 바꾼다. 설치 직후 상태가
바뀌므로 **재계산한 상태로** 승인 안내를 판단해야 한다.

```ts
  void (async () => {
    const dismissed = new Set<HookClient>(
      (['claude-code', 'codex', 'gemini-cli'] as HookClient[])
        .filter((c) => ctx.globalState.get<boolean>(`${DISMISS_KEY}.${c}`)));

    const announce = async (): Promise<void> => {
      const inputs = await computeCollection();
      const detected = new Set(inputs.map((i) => i.client));
      const states = new Map(inputs.map((i) => [i.client, i.install] as const));
      const awaiting = approvalPendingClients(detected, states, dismissed);
      if (awaiting.length === 0) return;
      const pick = await vscode.window.showWarningMessage(
        `MCP Lens: ${awaiting.join('·')} 훅을 켰습니다. codex를 한 번 실행해 뜨는 동의를 승인하면 수집이 시작됩니다.`,
        '수집 뷰 열기', '다시 안 보기');
      if (pick === '수집 뷰 열기') void vscode.commands.executeCommand('mcpLens.collection.focus');
      else if (pick === '다시 안 보기') {
        for (const c of awaiting) await ctx.globalState.update(`${DISMISS_KEY}.${c}`, true);
      }
    };

    const inputs = await computeCollection();
    const detected = new Set(inputs.map((i) => i.client));
    const states = new Map(inputs.map((i) => [i.client, i.install] as const));
    const pending = pendingHookClients(detected, states, dismissed);
    if (pending.length === 0) { await announce(); return; }

    const choice = await vscode.window.showInformationMessage(
      `MCP Lens: ${pending.join('·')} 훅 수집이 꺼져 있어요`, '모두 설치', '수집 뷰 열기', '다시 안 보기');
    if (choice === '모두 설치') {
      for (const c of pending) await installerFor(c).install();
      await announce();                       // 설치로 needs-approval이 됐는지 다시 본다
    } else if (choice === '수집 뷰 열기') {
      void vscode.commands.executeCommand('mcpLens.collection.focus');
    } else if (choice === '다시 안 보기') {
      for (const c of pending) await ctx.globalState.update(`${DISMISS_KEY}.${c}`, true);
    }
  })();
```

`import { pendingHookClients } from './nudge.js';`를 `approvalPendingClients`까지 포함하도록 고친다.

## 변경 6: 트리 행이 승인 대기를 표시한다

`packages/extension/src/hookStatus.ts`의 `clientRowPresentation`에 분기를 추가한다.

```ts
  if (install === 'needs-approval') {
    return present('승인 대기', 'codex 동의 필요',
      '훅을 켰지만 codex의 신뢰 승인이 남았습니다. codex를 한 번 실행하면 동의 프롬프트가 뜹니다. '
      + '승인하기 전까지 이 클라이언트의 MCP 호출은 로그로만 수집됩니다.', 'warning');
  }
```

`not-installed` 분기 바로 다음에 넣는다.

## 변경 7: 런타임 갱신이 승인 대기 상태에서도 동작한다

`packages/extension/src/runtimeFreshness.ts`의 `needsRuntimeRefresh`.

```ts
  // needs-approval도 파일은 이미 설치돼 있다 — 번들이 바뀌면 갱신 대상이다.
  // (갱신하면 hooks.json 해시가 바뀌어 codex가 재승인을 요구한다. 그것이 올바른
  //  보안 동작이며, 재승인이 필요해진 사실은 needs-approval 상태로 표면화된다.)
  if ((install !== 'installed' && install !== 'needs-approval') || bundled === null) return false;
```

## 변경 8: 결함 D 주석 정정

`packages/core/src/health/collectionHealth.ts`의 `HOOK_COVERAGE_PHASES` 주석이 사실과 다르다.
"Codex는 MCP 호출에 완료 단계 hook을 남기지 않고 tool-before만 남긴다"고 적혀 있으나, 실제 원인은
그 실기기의 `post_tool_use`에 `enabled = true`가 없었던 것이다. 켜면 `tool-after` hook이 정상적으로
나온다(실측 확인). 아래로 대체한다.

```ts
/**
 * hook 쪽에서 커버리지 증거로 인정하는 단계.
 * 클라이언트는 이벤트별로 hook을 따로 켤 수 있고(codex의 `hooks.state.*.enabled`),
 * 시작 단계만 켜고 완료 단계는 꺼 둔 구성이 실기기에서 관측됐다. 완료 단계만 인정하면
 * 그런 구성에서 상관키가 일치하는데도 전부 miss가 되어 건강도가 degraded로 굳고,
 * 회복 조건인 2연속 match가 영원히 성립하지 않는다.
 * 건강도는 수집기 생존을 재는 지표이므로 시작 단계 관측도 커버리지로 인정한다.
 */
```

동작은 바꾸지 않는다. 시작 단계만 켠 구성은 여전히 정당하므로 이 완화는 그대로 유효하다.

## 테스트

### 새 파일 `packages/extension/test/codexHookState.test.ts`

```ts
  it('섹션이 없으면 파일 끝에 enabled = true 테이블을 붙인다', () => {
    const out = withCodexHooksEnabled('[features]\nplugin_hooks = true\n');
    expect(out).toContain('[hooks.state."mcp-lens@mcplens:hooks/hooks.json:pre_tool_use:0:0"]');
    expect(readCodexHookStates(out).every((s) => s.enabled)).toBe(true);
    expect(out).toContain('[features]');            // 기존 내용 보존
  });

  it('trusted_hash만 있는 섹션에 enabled = true를 넣고 해시는 보존한다', () => {
    const before = [
      '[hooks.state."mcp-lens@mcplens:hooks/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).toContain('trusted_hash = "sha256:abc"');
    const state = readCodexHookStates(out).find((s) => s.key.includes('pre_tool_use'))!;
    expect(state).toMatchObject({ enabled: true, trusted: true });
  });

  it('enabled = false를 true로 바꾼다', () => {
    const before = [
      '[hooks.state."mcp-lens@mcplens:hooks/hooks.json:stop:0:0"]',
      'enabled = false',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).not.toContain('enabled = false');
    expect(readCodexHookStates(out).find((s) => s.key.includes('stop'))!.enabled).toBe(true);
  });

  it('이미 켜져 있으면 원문을 그대로 둔다 (멱등)', () => {
    const once = withCodexHooksEnabled('');
    expect(withCodexHooksEnabled(once)).toBe(once);
  });

  it('다른 플러그인 섹션과 그 뒤 테이블을 건드리지 않는다', () => {
    const before = [
      '[hooks.state."other@x:hooks/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:other"',
      '',
      '[features]',
      'plugin_hooks = true',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).toContain('[hooks.state."other@x:hooks/hooks.json:pre_tool_use:0:0"]');
    expect(out).toContain('trusted_hash = "sha256:other"');
    expect(out).toContain('plugin_hooks = true');
  });

  it('trusted_hash가 없으면 trusted는 거짓이다', () => {
    expect(readCodexHookStates(withCodexHooksEnabled('')).every((s) => s.trusted)).toBe(false);
  });
```

### `packages/extension/test/`의 codex 설치기 테스트

기존 설치기 테스트 파일이 있으면 거기에, 없으면 `codexInstaller.test.ts`를 새로 만든다.
`InstallerDeps`를 가짜로 주입해 실기기 자원을 쓰지 않는다.

```ts
  it('plugin은 있지만 enabled가 없으면 not-installed로 보고 설치가 다시 돈다', async () => {
    // fs.readFile이 hooks.state 섹션 없는 config를 돌려주는 deps로 detect() → 'not-installed'
  });

  it('enabled는 있고 trusted_hash가 없으면 needs-approval이다', async () => {
    // enabled = true만 있는 config → detect() === 'needs-approval'
  });

  it('enabled와 trusted_hash가 모두 있으면 installed다', async () => {
    // 둘 다 있는 config → detect() === 'installed'
  });

  it('config를 못 읽으면 fail-open으로 installed를 보고한다', async () => {
    // fs.readFile이 throw → detect() === 'installed' (재설치 루프 방지)
  });

  it('install이 config.toml에 enabled = true를 쓰고 백업을 남긴다', async () => {
    // writeFile 호출을 기록해 config.toml.mcplens.bak과 config.toml 둘 다 쓰였는지 단언
  });

  it('needs-approval이면 install은 alreadyInstalled로 조기 반환한다', async () => {
    // 설치 명령(run)이 한 번도 호출되지 않았는지 단언
  });
```

### `packages/extension/test/nudge.test.ts`

```ts
  it('needs-approval은 설치 대상이 아니라 승인 대상이다', () => {
    const detected = new Set<HookClient>(['codex']);
    const states = new Map<HookClient, InstallState>([['codex', 'needs-approval']]);
    expect(pendingHookClients(detected, states, new Set())).toEqual([]);
    expect(approvalPendingClients(detected, states, new Set())).toEqual(['codex']);
  });

  it('다시 안 보기로 지운 클라이언트는 승인 안내에서도 빠진다', () => {
    const detected = new Set<HookClient>(['codex']);
    const states = new Map<HookClient, InstallState>([['codex', 'needs-approval']]);
    expect(approvalPendingClients(detected, states, new Set(['codex']))).toEqual([]);
  });
```

기존 `nudge.test.ts`의 단언은 고치지 않는다 — `pendingHookClients`의 동작이 바뀌지 않는다.

### 기존 테스트 영향

`InstallState`에 값을 **추가**만 하므로 기존 분기는 그대로다. `hookStatus.test.ts`,
`hookStatusProvider.test.ts`, `runtimeFreshness.test.ts`의 기존 단언이 깨지면 구현이 계획과
다른 것이므로 임의로 고치지 말고 보고한다.

## 검증

- `npm run build`
- `npm test` 전량 통과
- `npx tsc --noEmit -p packages/core/tsconfig.json`
- `npx tsc --noEmit -p packages/extension/tsconfig.json`
- 실기기 검증(오케스트레이터가 수행): 현재 `~/.codex/config.toml`은 `enabled`와 `trusted_hash`가
  모두 있는 상태다. 이 상태에서 `detect()`가 `installed`를 반환하는지 확인한다.

## 이 계획이 다루지 않는 것

**`trusted_hash` 자동 기록.** 위 설계 판단에 근거를 적었다. 사용자 승인의 증거이므로 위조하지
않는다.

**claude-code·gemini-cli 설치기.** 두 클라이언트는 해시 기반 신뢰 게이트가 없어 이 문제가 없다
(실측: claude는 `~/.claude/settings.json`의 단순 enabled 플래그, 훅이 정상 동작 중).

**`uninstall()`의 `hooks.state` 정리.** 실측하지 않았고, 남은 항목은 무해하다.

## 실행 모델

파일이 여러 개지만 모두 한 관심사라 터미널을 나누지 않는다. 소유 파일:

- `packages/extension/src/hookInstall.ts`
- `packages/extension/src/installers/codex.ts`
- `packages/extension/src/installers/codexHookState.ts` (신규)
- `packages/extension/src/nudge.ts`
- `packages/extension/src/extension.ts`
- `packages/extension/src/hookStatus.ts`
- `packages/extension/src/runtimeFreshness.ts`
- `packages/core/src/health/collectionHealth.ts` (주석만)
- 위에 대응하는 테스트 파일들

`packages/core/src/types.ts`, `packages/core/src/store/schema.sql`는 수정하지 않는다.

서브에이전트 모델은 **sonnet**이다(계획서에 판단이 갈리는 코드가 전량 있다).

## 사람이 할 일

```
git log --oneline -1        # 이 계획서 커밋이어야 한다
git status --short          # 추적 파일에 예상 밖 변경이 없어야 한다
```

## 실행 프롬프트

~~~text
당신은 Wave 3 결함 G 보정의 터미널 오케스트레이터다. 목표는 사용자가 "모두 설치"를 눌러도 codex 훅이 실제로는 하나도 실행되지 않는데 확장이 설치 성공으로 보고하는 거짓 성공을 없애는 것이다.

[1단계: 작업 공간 만들기] 다른 무엇보다 먼저 이것부터 해라.

`git rev-parse --show-toplevel`과 `pwd`가 `/Users/doo._.hyun/Study/Project/MCPLens-V2`인지, `git rev-parse --git-dir`와 `git rev-parse --git-common-dir`가 같은지 확인한다. 연결 worktree 안이면 중단하고 보고한다.

`MCPLENS_BASE=$(git rev-parse HEAD)`를 기록한다. 그 다음
  `git worktree add .claude/worktrees/mcplens-fix-g -b fix/codex-hook-enable $MCPLENS_BASE`
를 실행한 뒤 EnterWorktree 도구에 path로 그 worktree의 절대 경로를 넘겨 세션을 그 안으로 옮겨라. 같은 이름의 worktree나 브랜치가 이미 있으면 새로 만들지 말고 중단하고 보고한다.

진입 후 아래를 확인하고, 하나라도 어긋나면 중단하고 보고해라.
  - `pwd`가 그 worktree인지
  - `git log --oneline -1`이 `$MCPLENS_BASE`와 같은지
  - `test -f MCP-Lens-설계문서-v2.md`
  - `test -f docs/plans/2026-08-04-wave3-결함-g-codex-훅-활성화-계획.md`
  - `git status --short`가 비어 있는지

`.claude/skills`와 `docs/pitfalls`는 untracked라 따라오지 않는다. 진입 직후
  `mkdir -p .claude && cp -R /Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/skills .claude/skills`
  `cp -R /Users/doo._.hyun/Study/Project/MCPLens-V2/docs/pitfalls docs/pitfalls`
를 실행한다. 이 두 경로는 worktree에서 고치지 않는다.

의존성은 이 worktree에서 `npm ci`로 직접 설치한다. 설치 후 **`npm run build`를 `npm test`보다 먼저 실행한다.** 새 worktree에는 `packages/core/dist/`가 없어 빌드를 건너뛰면 extension 테스트가 실패한다. 그 다음 `npm test`로 기준선이 전량 통과하는지 확인한다. 실패하면 코드를 고치기 전에 BLOCKED로 보고한다.

[2단계: 실행]

`docs/plans/2026-08-04-wave3-결함-g-codex-훅-활성화-계획.md`를 처음부터 끝까지 읽고 그대로 구현한다. 서브에이전트 하나를 model sonnet으로 스폰해 맡기고, 당신은 리뷰만 한다.

자식에게 다음을 지시한다.

  계획서의 "변경 1"부터 "변경 8"까지와 "테스트" 절을 전부 구현한다. 소유 파일은 계획서 "실행 모델" 절에 열거된 것뿐이다. packages/core/src/types.ts와 packages/core/src/store/schema.sql은 수정하지 않는다. packages/core/src/health/collectionHealth.ts는 주석만 고치고 동작은 바꾸지 않는다. InstallState에 needs-approval을 추가하는 것은 값 추가일 뿐이므로 기존 분기는 그대로여야 한다. 기존 테스트의 단언이 깨지면 구현이 계획과 다르다는 뜻이므로 임의로 테스트를 바꾸지 말고 원인을 보고한다. 유닛테스트는 가짜 InstallerDeps와 인메모리 데이터만 쓴다. 실기기 자원(~/.codex/config.toml, ~/.mcplens, 실제 codex 실행)은 절대 건드리지 않는다. 끝나면 `npm run build`, `npm test`, `npx tsc --noEmit -p packages/core/tsconfig.json`, `npx tsc --noEmit -p packages/extension/tsconfig.json`을 실행하고 결과를 보고한다. 커밋·merge·push는 하지 않는다.

자식이 끝나면 당신이 검증한다. `git diff --stat`으로 소유 파일 밖 변경이 0건인지 확인한다. `git diff packages/core/src/health/collectionHealth.ts`가 주석만 바꿨는지 직접 확인한다. `npm test` 전량 통과, tsc 양쪽 통과를 확인한다. 하나라도 어긋나면 고치게 하고 다시 검증한다.

전부 통과하면 한국어로 원자적 커밋 하나를 만든다. 커밋 메시지는 실측(enabled와 trusted_hash가 둘 다 있어야 codex가 훅을 실행한다), 역할 분담의 근거(enabled는 사용자가 설치를 눌러 동의했으므로 우리가 쓰고, trusted_hash는 사용자 승인의 증거라 위조하지 않는다), 결함 D 주석이 왜 틀렸는지를 담는다. push는 하지 않는다.

마지막에 사용자에게 브랜치명, 커밋 SHA, 검증 결과, 남은 위험을 보고한다.
~~~

## 통합 게이트

1. 브랜치가 기점을 포함하는지 확인한다
2. `npm run build && npm test` 전량 통과를 확인한다
3. 실기기에서 `detect()`가 현재 config(enabled+trusted 모두 있음)에 대해 `installed`를 반환하는지 확인한다
4. 통합 SHA를 `docs/task-integration-ledger.tsv`에 원장 키 `14-codex-hook-enable-remediation`으로 기록한다
