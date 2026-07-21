# Claude Code 훅 자동 설치 (VS Code 확장) — 설계

**작성일:** 2026-07-21
**상태:** 설계 승인 (구현 계획 대기)

## 목적

VS Code 확장 사용자가 **설정 파일을 직접 편집하지 않고**, 알림창 클릭 한 번으로 Claude Code
lifecycle 훅 수집을 켤 수 있게 한다. 현재는 훅을 각 클라이언트에 수동 설치해야 하며, 확장은
inbox를 drain해 읽기만 한다.

이 설계는 2026-07-21 세션에서 **수동으로 검증된 설치 경로**(로컬 마켓플레이스 등록 →
`claude plugin install` → 새 세션에서 훅 발화 → 레댁션·정준화 확인)를 확장이 자동으로
수행하도록 만든다. 실기기 검증 기록: `docs/SMOKE.md` "Claude Code 실기기 검증".

## 범위

- **대상: Claude Code 전용.** Codex·Gemini CLI는 동일 패턴으로 이후 확장(비목표).
- 설치 트리거: 확장 시작 시 1회 알림 + 항상 사용 가능한 명령.

### 비목표 (Non-goals)

- Codex/Gemini 자동 설치 (별도 후속).
- **완전 무음 설치**: 훅은 세션 시작 시 로드되므로, 설치 후 사용자가 **새 Claude 세션을
  시작**하는 단계는 구조적으로 남는다(자동화 불가). 설치는 자동, 활성화는 새 세션.
- `claude` CLI가 없는 환경 지원(그 경우 안내만 하고 중단).

## 설치 방식 결정 — 방식 A (claude CLI)

확장이 뒤에서 공식 `claude` CLI를 실행해 번들 플러그인을 설치한다.

**대안 B(‑settings.json 직접 편집)를 채택하지 않은 이유:** 사용자 `~/.claude/settings.json`을
직접 수정해 기존 훅과 병합해야 하고, 프로젝트 설계 원칙("settings.json 무수정")과 충돌한다.
방식 A는 사용자 설정 파일을 건드리지 않고, 제거가 공식 명령(`claude plugin uninstall`)이라
깔끔하며, 이번 세션에 실제 작동이 검증됐다.

사용자 경험은 두 방식이 동일(알림 클릭 → 완료). 차이는 "누가 설정을 쓰느냐"뿐이며, A는
Claude Code의 공식 설치 창구에 위임한다.

## 아키텍처 — 모듈 경계

VS Code API와 설치 로직을 분리해 유닛 테스트 가능하게 한다 (기존 `hookStatus.ts` 패턴).

### `packages/extension/src/hookInstall.ts` (vscode import 없음)

순수 오케스트레이션. 의존성(`spawn`, `fs`, `home`, `logger`)을 주입받는다.

```ts
export interface HookInstallDeps {
  home: string;
  runClaude: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  findClaudeBinary: () => string | null;
  fs: {
    copyDir: (from: string, to: string) => void;
    exists: (path: string) => boolean;
    readDir: (path: string) => string[];
    readFile: (path: string) => string;
  };
  bundledMarketplaceDir: string; // 확장이 번들한 마켓플레이스 에셋 경로
}

export type InstallState =
  | { kind: 'installed' }                       // 이미 설치·활성
  | { kind: 'not-installed' }                    // 설치 가능
  | { kind: 'claude-missing' };                  // claude 바이너리 없음

export function detectClaudeHookInstall(deps: HookInstallDeps): InstallState;

export type InstallResult =
  | { kind: 'ok'; alreadyInstalled: boolean }
  | { kind: 'claude-missing' }
  | { kind: 'failed'; step: string; stderr: string };

export async function installClaudeHooks(deps: HookInstallDeps): Promise<InstallResult>;
export async function uninstallClaudeHooks(deps: HookInstallDeps): Promise<InstallResult>;
```

### `packages/extension/src/extension.ts` (VS Code 배선만)

activate에서 알림 트리거 + 명령 2개 등록. `runClaude`/`findClaudeBinary`/`fs`의 실제 구현을
주입한다.

## 설치 플로우 (알림 [설치] 클릭 시)

```
1. findClaudeBinary()  — PATH → ~/.local/bin/claude → 실패 시 InstallState 'claude-missing'
2. detectClaudeHookInstall() — 이미 설치면 즉시 { ok, alreadyInstalled: true }
3. 번들 마켓플레이스를 안정 경로로 동기화:
     ~/.mcplens/claude-marketplace/  (확장 업데이트에도 안 사라지게 copyDir)
4. claude plugin marketplace add ~/.mcplens/claude-marketplace   (멱등 — 이미 있으면 무해)
5. claude plugin install mcp-lens@mcplens                        (멱등)
6. 성공 → { ok } → 알림 "설치 완료 — 새 Claude 세션을 시작하면 수집이 시작됩니다"
   실패 → { failed, step, stderr } → 알림에 stderr 표시, activate·수집은 계속
```

마켓플레이스 이름은 `mcplens`, 플러그인 이름은 `mcp-lens` → 설치 식별자 `mcp-lens@mcplens`.

## 번들링 / 패키징

- 확장 `.vsix`에 자기완결 플러그인 에셋을 포함한다:
  `lens-audit-plugin`의 `scripts/`·`runtime/`·`hooks/`·`.claude-plugin/`·`commands/`와,
  이를 감싸는 `marketplace.json`(플러그인 source `./mcp-lens` 상대경로).
- 확장 `vscode:prepublish`/`package` 단계에 에셋 복사를 추가한다. `verify-hook-packages.mjs`가
  runtime byte-identical을 이미 보장하므로 동일 소스를 재사용한다.
- **안정 경로 이유:** `claude plugin marketplace add`는 소스 경로를 업데이트용으로 기록한다.
  확장 설치 폴더는 버전마다 바뀌므로 `~/.mcplens/claude-marketplace/`로 복사해 등록한다.
  activate마다 번들 버전이 더 최신이면 재동기화한다(자가 치유).

## 멱등성 · 감지

- **이미 설치 판정**: `claude plugin list` 출력에서 `mcp-lens@mcplens ... installed`를 확인.
  파싱 실패 시 캐시 경로 폴백 — `~/.claude/plugins/cache/*/mcp-lens/*/scripts/hook-runner.mjs`
  존재 여부(2026-07-21 CLI 수정과 동일한 cache-glob).
- 이미 설치 → 알림 안 뜸. 설치 명령 수동 실행 시 "이미 설치됨" 안내.
- 마켓플레이스 add / plugin install은 재실행해도 무해(멱등)하도록 처리하고, 실패 stderr에
  "already exists" 류는 성공으로 흡수한다.
- **감지 로직 공유(선택, 이번 범위 밖):** CLI(`hooks-status.ts`)와 확장이 cache-glob 감지를
  중복 구현한다. 추후 공유 리졸버를 `@mcp-lens/core`로 추출하면 DRY. 이번 스펙은 범위를 좁혀
  확장에 최소 복제하고 core는 건드리지 않는다.

## 알림 트리거 (시작 시 1회)

```
확장 시작 (onStartupFinished)
  └ detectClients()로 Claude 감지 && detect 'not-installed' && globalState 'dismissed'≠true
     → 알림: "MCP Lens: Claude Code 훅 수집을 켜시겠어요?"  [설치] [나중에] [다시 안 보기]
  └ 'installed' → 알림 없음
  └ 'claude-missing' → 알림 없음(명령 실행 시에만 안내)
```

- **[설치]** → `installClaudeHooks()` 실행 후 결과 알림.
- **[나중에]** → 아무 상태 저장 안 함(다음 시작 때 다시 물음).
- **[다시 안 보기]** → `globalState['mcpLens.hookInstall.dismissed'] = true`.

## 명령 (항상 사용 가능)

- `mcp-lens.installClaudeHooks` — "MCP Lens: Install Claude hooks"
- `mcp-lens.uninstallClaudeHooks` — "MCP Lens: Uninstall Claude hooks"
  (`claude plugin uninstall mcp-lens@mcplens` + `claude plugin marketplace remove mcplens`)

package.json `contributes.commands`에 등록.

## 에러 처리 (fail-open)

- claude 미탐색 / spawn 실패 / 비정상 exit → 사용자 알림으로 표면화하되 **activate와 로그
  수집은 계속**한다. 설치 실패가 확장 기능을 막지 않는다.
- 각 claude 명령의 stderr를 결과에 담아 알림 본문에 노출한다(진단 가능).
- 훅 미설치 상태여도 기존 로그 백필·inbox drain은 그대로 동작한다.

## 테스트

### `packages/extension/test/hookInstall.test.ts` (VS Code API 없음)

주입된 fake `runClaude`/`fs`/`findClaudeBinary`로 검증:

1. 정상 설치 — `marketplace add` → `plugin install` 순서로 호출, `{ ok, alreadyInstalled:false }`.
2. 이미 설치 — `plugin list`가 installed 반환 시 install 명령 미호출, `{ ok, alreadyInstalled:true }`.
3. claude 미탐색 — `findClaudeBinary()` null → `{ claude-missing }`, 명령 미호출.
4. 설치 실패 — `plugin install` 비정상 exit → `{ failed, step:'install', stderr }`.
5. 멱등 — `marketplace add`가 "already exists" stderr여도 진행.
6. uninstall — `plugin uninstall` → `marketplace remove` 순서.

### 실기기 스모크

확장이 자동 실행하는 시퀀스는 2026-07-21에 수동으로 검증한 것과 동일하므로, `.vsix` 설치 후
알림 [설치] → 새 세션 → MCP 호출 → inbox 봉투 확인을 `docs/SMOKE.md`에 기록한다(사용자
조작 필요 단계).

## 성공 기준

- 확장 설치 후 Claude Code 감지 시 1회 알림이 뜬다.
- [설치] 클릭 → 사용자 편집 없이 훅 플러그인이 설치·활성된다(`claude plugin list`에 노출).
- 새 세션에서 MCP 호출 시 `~/.mcplens/inbox`에 레댁션된 봉투가 쌓인다.
- 이미 설치된 경우 알림이 뜨지 않는다.
- `claude` 미탐색·설치 실패 시 확장·수집이 계속 동작하고 사용자에게 원인이 안내된다.
- Uninstall 명령으로 깔끔히 원복된다.

## 위험 / 열린 질문

- `claude` 바이너리 위치 다양성 — PATH 외 위치는 알려진 후보만 탐색; 실패 시 수동 안내.
- VS Code 확장 프로세스의 `PATH`가 로그인 셸과 다를 수 있음 → `findClaudeBinary`가 알려진
  절대 경로 후보를 반드시 포함.
- 확장 번들 크기 증가(플러그인 runtime 포함) — `verify-hook-packages`가 보장하는 최소 서브셋만.
