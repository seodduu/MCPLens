# Codex·Gemini 훅 수집 패리티 설계

> 상태: 설계 승인안. 구현 계획(writing-plans)의 기준 문서.
> 상위 기준: `docs/designs/2026-07-20-공식-hook-우선-수집-설계.md`(수집 계약·배포),
> `MCP-Lens-설계문서-v2.md`(회계 모델).
> 이 문서는 위 설계가 정의한 3-클라이언트 수집을 **VS Code 확장 쪽 설치·감지·건강도**까지
> 완성하는 통합 설계다. 수집 계약(훅 이벤트·상관관계 키·ingest 디코더)은 이미 구현돼 있어
> 재설계하지 않는다.

## 1. 배경 — 무엇이 이미 있고 무엇이 빠졌나

훅-우선 수집 설계와 그 구현으로 다음이 이미 존재한다.

- 3개 클라이언트 훅 이벤트·상관관계 키·설치 방식 명세 (상위 설계 §12).
- 런타임 패키지: `packages/codex-plugin/`, `packages/gemini-extension/`
  (각 `plugin`/`extension` 매니페스트, `hooks/hooks.json`, `hook-runner.mjs`,
  3-클라이언트 ingest 디코더).
- 공용 런타임 동기화 `packages/hook-runtime/scripts/sync-runtime.mjs`는 이미
  `lens-audit-plugin`·`codex-plugin`·`gemini-extension` 셋을 모두 대상으로 한다.
- `ingest_observations.client` 열 — 관측치가 이미 클라이언트별로 구분돼 저장된다.

**빠진 것**: VS Code 확장(`packages/extension/src`)이 codex-plugin·gemini-extension을
전혀 참조하지 않는다. 확장에는 Claude 전용 `installClaudeHooks`/`detectClaudeHookInstall`만
있고, 시작 넛지·수집 건강도 표시도 Claude 전용이다. 결과적으로 codex·gemini는:

1. 훅 설치 여부를 감지하지 못하고,
2. 설치를 유도하는 넛지·액션이 없으며,
3. 수집 건강도가 전 클라이언트 단일값으로 뭉쳐 있어(현 `deriveCollectionHealth`가 전역),
   "누가 연결됐고 누가 안 됐나"를 알 수 없다.

## 2. 목표 / 비목표

### 2.1 목표

- codex·gemini에 대해 Claude와 동일한 **풀 패리티**: (A) 설치 여부 자동 감지,
  (B) 원클릭 설치, (C) 수집 건강도 표시 — 셋 다.
- 건강도를 **클라이언트별로 분리** 표시한다 (상위 설계 §11이 전제하던 모습).
- 설치·감지·제거를 클라이언트별 CLI 셸 아웃으로 처리하되, 하나의 인터페이스로 통합한다.
- 수집기 설치·실패가 사용자의 MCP 호출로 전파되지 않는다 (상위 설계 핵심 원칙 유지).

### 2.2 비목표

- 수집 계약(훅 이벤트/상관관계/ingest 디코더) 재설계 — 이미 구현됨, 손대지 않음.
- MCP Proxy 경로 — 별도 선택 기능, 이 설계 범위 밖.
- 과거 세션 백필 방식 변경 — 기존 로그 어댑터 유지.
- 실기기 설치 자동화 테스트 — 유닛 범위 밖(§7의 직렬 스모크로 수동 검증).

## 3. 공유 계약 불변 원칙

변경은 `packages/extension/`과 `packages/core/src/health`·`store`·`engine/healthGate`에
집중한다. 다음 **공유 계약 파일은 수정하지 않는다**:
`packages/core/src/types.ts`, `packages/core/src/store/schema.sql`, 루트 설정.

per-client 처리가 스키마 변경 없이 가능한 이유: `ingest_observations.client` 열이 이미 있다.

## 4. 설치기 추상화 & 번들링

### 4.1 인터페이스

Claude 전용 `hookInstall.ts`를 클라이언트별 설치기 인터페이스로 일반화한다.

```ts
type HookClient = 'claude-code' | 'codex' | 'gemini-cli';
type InstallState = 'installed' | 'not-installed' | 'client-missing';
type InstallResult =
  | { kind: 'ok'; alreadyInstalled: boolean }
  | { kind: 'client-missing' }
  | { kind: 'failed'; step: string; stderr: string };

interface ClientHookInstaller {
  readonly client: HookClient;
  detect(): Promise<InstallState>;
  install(): Promise<InstallResult>;
  uninstall(): Promise<InstallResult>;
}
```

세 구현이 각자의 CLI를 감싼다. 전부 기존 `runClient(bin, args): Promise<RunResult>`
셸 아웃 패턴을 재사용한다.

| | 감지 | 설치 | 제거 | 설치 단위 |
|---|---|---|---|---|
| **claude** | `plugin list --json` (기존 유지) | `plugin marketplace add <snapshot>` → `plugin install mcp-lens@mcplens` | `plugin uninstall` → `marketplace remove` | 마켓플레이스 스냅샷 |
| **codex** | `plugin list` **텍스트** 파싱(STATUS 열) | `plugin marketplace add <snapshot>` → `plugin add mcp-lens@mcplens` | `plugin remove` | 마켓플레이스 스냅샷 |
| **gemini** | `extensions list` 파싱 | `extensions install <bundledDir>` | `extensions uninstall mcp-lens` | 경로 직접설치 |

- Codex `plugin list`는 JSON이 아니라 텍스트 표라, `PLUGIN`/`STATUS` 열에서
  `mcp-lens@mcplens`의 상태(`installed, enabled`)를 파싱한다. Claude의
  `pluginListReportsInstalled`에 대응하는 codex 전용 파서를 둔다.
- Gemini는 마켓플레이스 단계 없이 번들 디렉토리 경로를 직접 설치한다. 개발용
  `extensions link`가 아니라 배포판은 `install <path>`(안정 복사본)를 쓴다.
- 감지 실패·CLI 부재는 `client-missing`으로 통일한다(바이너리 미발견).

### 4.2 안정 경로 & 번들링

Claude의 `stableMarketplaceDir(~/.mcplens/claude-marketplace)` 패턴을 확장한다.

- `~/.mcplens/codex-marketplace`, `~/.mcplens/gemini-extension` 안정 경로 추가.
- 설치기는 확장 번들 경로에서 안정 경로로 복사 후 CLI로 등록한다.
- `esbuild.mjs`는 지금 `dist/claude-marketplace`를 만들듯, `dist/codex-marketplace`·
  `dist/gemini-extension`도 함께 복사한다(각 `packages/codex-plugin`·
  `packages/gemini-extension`에서). `__dirname` 기준 경로로 참조.
- 공용 런타임 동기화(`sync-runtime.mjs`)는 이미 3개 패키지를 다루므로 변경 없음.

## 5. 클라이언트별 수집 건강도

### 5.1 파생

현 `deriveCollectionHealth`는 전 관측치를 뭉쳐 단일 스냅샷을 낸다. 이를 클라이언트별로 쪼갠다.

- `ingest_observations.client`로 그룹핑 → 클라이언트마다 스냅샷 1개.
- store에 `collectionHealthByClient(now?): Map<HookClient, CollectionHealthSnapshot>`
  추가. 기존 `collectionHealth()`(전역)는 상태바 요약이 쓰므로 유지한다.
- `deriveCollectionHealth`의 순수 로직은 재사용 — 입력 관측치를 클라이언트별로
  나눠 각각 호출하면 된다(함수 시그니처 불변).

### 5.2 표시 상태 = f(설치상태, 관측건강도)

관측만으로는 "미연결"을 표현할 수 없다. 설치기 `detect()` 결과와 관측 건강도를 합성한다.

| 조건 | 트리 표시 | 인라인 액션 |
|---|---|---|
| `not-installed` | `○ 미연결 — 설치 필요` | **[설치]** |
| `installed` + hook·log 일치(`healthy`) | `✓ 정상 · Hook+로그` | [제거] |
| `installed` + hook만(`hook-only`) | `◐ 부분 측정 · Hook only` | [제거] |
| `installed` + log만(`log-only`) | `◐ 첫 이벤트 대기 · Log only` | [제거] |
| `installed` + 관측 0(`idle`) | `◐ 첫 이벤트 대기` | [제거] |
| `installed` + `degraded` | `⚠ 성능 저하 · 상관 불일치` | [제거] |
| `client-missing` | 행 숨김 | — |

기존 `formatCollectionHealth`의 라벨·심각도를 재사용하되, `not-installed`·`client-missing`
분기를 앞단에서 처리한다(설치상태가 관측건강도를 선점).

### 5.3 수집 트리 렌더러

`hookStatusProvider`를 단일 노드 → **감지된 클라이언트마다 행 1개**로 바꾼다.

- 행 구성원: `detectClients()`가 설치됐다고 보고한 클라이언트(+ 훅 설치 상태).
- 각 행 = 상태 라벨 + 컨텍스트 메뉴 액션([설치]/[제거]).
- 전역 상태바 요약은 클라이언트별 건강도의 **최악값** 기준으로 유지.

### 5.4 권고 게이트

`healthGate.ts`는 현재 전역 스냅샷 하나로 제거 권고를 낮춘다. 엔진이 이미
`splitByClient`로 클라이언트별로 도므로, **각 클라이언트 행은 자기 건강도로 게이팅**한다.

- 예: gemini가 log-only여도 claude 권고 확신은 낮추지 않는다.
- 전역 상태바 요약만 최악값을 쓴다.

## 6. 설치 UX · 시작 넛지 · 에러 처리

### 6.1 트리 액션 커맨드

기존 deny/allow 토글과 같은 커맨드 패턴을 따른다.

- `mcp-lens.installHooks(node)` / `mcp-lens.uninstallHooks(node)` — 노드의 `client`로
  해당 설치기 호출.
- 성공 시 트리·건강도 refresh + `"새 <client> 세션부터 수집이 시작됩니다"` 안내.

### 6.2 시작 넛지 (통합 하나)

Claude 전용 모달을, 감지된 클라이언트 전체를 훑어 **훅이 꺼진 설치 클라이언트가
하나라도 있으면** 한 번만 띄운다.

> `MCP Lens: <미연결 목록> 훅 수집이 꺼져 있어요` — **[모두 설치] [수집 뷰 열기] [다시 안 보기]**

- **[모두 설치]** — 미연결 클라이언트를 순차 설치(편의용 원클릭).
- **[수집 뷰 열기]** — 수집 트리에 포커스(개별 설치 창구, 옵션 1의 주 경로).
- **[다시 안 보기]** — **클라이언트별 dismiss 키**(`mcpLens.hookInstall.dismissed.<client>`).
  이미 결정한 클라이언트만 억제 → 지금의 전역 단일 키(하나 끄면 전부 꺼짐) 문제도 해소.
- `client-missing`은 넛지·트리에서 제외한다.

### 6.3 에러 처리

- 설치기는 `InstallResult` 유니온 반환. `failed` → `showErrorMessage(step + stderr 앞 300자)`.
  `client-missing` → info 메시지.
- `detect()` 선행 → 이미 설치면 no-op `ok`. 제거는 "not installed" 관대 처리.
- 설치는 임시 경로 복사 후 검증·원자적 등록. 실패해도 사용자의 MCP 호출엔 무영향.

## 7. 테스트

전부 픽스처 + `:memory:` DB만 사용한다(프로젝트 규칙: 터미널 병렬 안전).

- **설치기별**: `detect()` 파싱(codex `plugin list` 텍스트, gemini `extensions list`
  포맷), 설치 커맨드 시퀀스, 제거, `failed`/`client-missing` 전파 — `runClient`·`fs` 목킹.
  - 신규 픽스처: `fixtures/cli/codex-plugin-list.txt`, `fixtures/cli/gemini-extensions-list.txt`.
- **per-client 건강도**: 클라이언트별 그룹핑 + 상태 합성 `f(설치상태, 관측건강도)` 테이블 드리븐.
- **트리 렌더링**: 클라이언트별 행·상태 라벨·액션 매핑.
- **시작 넛지 로직**: 트리거 대상 클라이언트, 클라이언트별 dismiss.
- **게이트 per-client**: gemini log-only가 claude 권고를 낮추지 않음.
- 기존 codex/gemini 훅 페이로드 디코딩은 ingest 테스트가 이미 커버 → 회귀만 확인.

**직렬 스모크(Wave 4, 유닛 밖)**: 실제 `codex`/`gemini` CLI 기동 설치·제거 수동 검증.
`bundle-smoke`에 `dist/codex-marketplace`·`dist/gemini-extension` 존재 검사 추가.

## 8. 변경 파일 맵

| 파일 | 변경 |
|---|---|
| `extension/src/hookInstall.ts` | `ClientHookInstaller` 인터페이스 + claude 구현 리팩터 |
| `extension/src/installers/codex.ts` (신규) | codex 설치기 |
| `extension/src/installers/gemini.ts` (신규) | gemini 설치기 |
| `extension/src/hookStatusProvider.ts` | 단일 노드 → 클라이언트별 행 + 액션 |
| `extension/src/extension.ts` | 넛지 통합·per-client dismiss, install/uninstall 커맨드 |
| `extension/esbuild.mjs` | dist에 codex-marketplace·gemini-extension 번들 |
| `extension/package.json` | 트리 뷰 컨텍스트 메뉴에 설치/제거 액션 기여점 |
| `core/src/health/collectionHealth.ts` | (필요 시) 그룹핑 헬퍼 — 순수 파생 로직 재사용 |
| `core/src/store/store.ts` | `collectionHealthByClient()` 추가 |
| `core/src/engine/healthGate.ts` | 클라이언트별 게이팅 |

`types.ts`·`schema.sql`·루트 설정은 불변.

## 9. 열린 위험

- **Codex `plugin list` 텍스트 포맷 변동**: JSON이 아니라 표라 포맷 변경에 취약.
  마켓플레이스 스냅샷 경로 존재 여부를 폴백 감지로 둔다(Claude의 `hasCachedRunner` 대응).
- **CLI 버전차**: `codex plugin add`·`gemini extensions install` 인자 형태가 버전마다
  다를 수 있음 — 설치 실패를 `failed{step}`로 정직히 표면화하고 넛지에서 재시도 가능하게.
- **넛지 피로**: 클라이언트별 dismiss로 완화. "모두 설치"는 편의일 뿐 강제 아님.
