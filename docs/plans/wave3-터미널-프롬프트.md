# Wave 3 터미널 프롬프트 (복붙용)

각 터미널에서 `cd /Users/doo._.hyun/Study/Project/MCPLens && claude` 실행 후, 해당 코드 블록 내용을 그대로 붙여넣는다.
4개 세션이 모두 끝나면 메인 터미널에서 머지(cli → extension → dashboard → plugin 순)를 요청한다.

---

## T1 — CLI (Task 10)

```text
너는 MCP Lens 프로젝트 Wave 3의 T1 오케스트레이터야.

먼저 작업 공간을 격리해: git worktree add ../MCPLens-cli -b feat/cli 를 실행하고,
이후 모든 작업은 ../MCPLens-cli 워크트리 안에서 수행해. npm install 먼저 실행해.

그 다음 docs/plans/2026-07-19-mcp-lens-mvp-구현계획.md 의 Task 10 (CLI npx mcp-lens)만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해.

소유 디렉토리는 packages/cli/ 전체야. 그 밖의 파일(core 내부, 루트 설정)은 너도
서브에이전트도 절대 수정하지 마. 계약이 안 맞으면 수정하지 말고 보고해.

참고: core 공개 API는 @mcp-lens/core 에서 전부 import 가능하다 (ClaudeAdapter,
CodexAdapter, GeminiAdapter 클래스, LensStore, LogWatcher, buildMatrix, sessionSavings,
dbPath, detectClients). formatReport는 순수 함수로 유닛테스트하고, --format ai의
첫 줄은 반드시 "# MCP Lens Audit" (Task 13 플러그인이 소비하는 계약).

주의: Task 10 Step 3의 실기기 스모크(실제 DB로 report 실행)는 수행 금지 — Wave 4로
이월한다. 유닛테스트까지만 하고 커밋해.

완료 기준: report.ts 테스트 전부 통과 + 빌드 성공 + feat/cli 브랜치에 커밋 완료.
끝나면 커밋 SHA와 테스트 결과를 보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
```

---

## T2 — VS Code 확장 (Task 11)

```text
너는 MCP Lens 프로젝트 Wave 3의 T2 오케스트레이터야.

먼저 작업 공간을 격리해: git worktree add ../MCPLens-ext -b feat/extension 을 실행하고,
이후 모든 작업은 ../MCPLens-ext 워크트리 안에서 수행해. npm install 먼저 실행해.

그 다음 docs/plans/2026-07-19-mcp-lens-mvp-구현계획.md 의 Task 11 (VS Code 확장)만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해.

소유 디렉토리는 packages/extension/ 전체야. 그 밖의 파일(core 내부, 루트 설정)은 너도
서브에이전트도 절대 수정하지 마. vscode 모듈 import는 이 패키지 안에서만 허용된다
(core에 스며들면 안 됨). 계약이 안 맞으면 수정하지 말고 보고해.

참고: core 공개 API는 @mcp-lens/core 에서 전부 import 가능하다 (어댑터 3종 클래스,
LensStore, LogWatcher, buildMatrix, sessionSavings, dbPath, detectClients).
DB는 반드시 dbPath() (= ~/.mcplens/lens.db) — globalStorageUri 금지.

주의: Task 11 Step 4의 F5 수동 스모크(실제 DB 접근)는 수행 금지 — Wave 4로 이월한다.
formatStatus 유닛테스트와 tsc 빌드 통과까지만 하고 커밋해.

완료 기준: statusBar 테스트 통과 + 빌드 성공 + feat/extension 브랜치에 커밋 완료.
끝나면 커밋 SHA와 테스트 결과를 보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
```

---

## T3 — 대시보드 (Task 12)

```text
너는 MCP Lens 프로젝트 Wave 3의 T3 오케스트레이터야.

먼저 작업 공간을 격리해: git worktree add ../MCPLens-dash -b feat/dashboard 를 실행하고,
이후 모든 작업은 ../MCPLens-dash 워크트리 안에서 수행해. npm install 먼저 실행해.

그 다음 docs/plans/2026-07-19-mcp-lens-mvp-구현계획.md 의 Task 12 (대시보드)만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해.

소유 디렉토리는 packages/dashboard/ 전체야. 그 밖의 파일(core 내부, 루트 설정)은 너도
서브에이전트도 절대 수정하지 마. 계약이 안 맞으면 수정하지 말고 보고해.

참고: core 공개 API는 @mcp-lens/core 에서 전부 import 가능하다. HTTP 계약
(GET /api/matrix?days=30, /api/sessions?days=7, /api/timeline/:sessionId, GET / 정적)을
계획서대로 구현하고, server.ts 테스트는 LensStore.open(':memory:') + fake 데이터로
HTTP 왕복만 검증해 — 실제 ~/.mcplens DB를 만지지 마.

주의: Step 4의 브라우저 수동 스모크는 수행 금지 — Wave 4로 이월한다.
React 앱은 vite 빌드가 통과하는 수준까지 구현하고 커밋해.

완료 기준: server HTTP 계약 테스트 통과 + 빌드 성공 + feat/dashboard 브랜치에 커밋 완료.
끝나면 커밋 SHA와 테스트 결과를 보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
```

---

## T4 — /lens-audit 플러그인 (Task 13)

```text
너는 MCP Lens 프로젝트 Wave 3의 T4 오케스트레이터야.

먼저 작업 공간을 격리해: git worktree add ../MCPLens-plugin -b feat/plugin 을 실행하고,
이후 모든 작업은 ../MCPLens-plugin 워크트리 안에서 수행해.

그 다음 docs/plans/2026-07-19-mcp-lens-mvp-구현계획.md 의 Task 13 (/lens-audit 플러그인)만
수행해. 이 태스크는 마크다운 파일 3개 작성이라 서브에이전트 스폰 없이 직접 해도 된다.

소유 디렉토리는 packages/lens-audit-plugin/ 전체야. 그 밖의 파일은 절대 수정하지 마.

참고: 플러그인이 소비하는 계약은 Task 10 CLI의 `npx mcp-lens report --days 30 --format ai`
출력이며 첫 줄이 "# MCP Lens Audit"이다. CLI는 병렬 트랙(T1)에서 만들어지는 중이므로
Step 2의 실행 검증은 수행 금지 — Wave 4로 이월한다. plugin.json, commands/lens-audit.md,
README.md 작성과 프론트매터(allowed-tools) 정합성 확인까지만 하고 커밋해.

완료 기준: 파일 3개 작성 + feat/plugin 브랜치에 커밋 완료.
끝나면 커밋 SHA를 보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
