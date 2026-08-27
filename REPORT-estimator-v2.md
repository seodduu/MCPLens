# 툴 정의 토큰 추정기 v2 구현 보고

계획서: `docs/plans/2026-08-27-툴정의-토큰-추정기-v2-구현계획.md`
브랜치: `feat/estimator-v2` (기점 `8fb2af7`). 푸시·머지하지 않았다.
작성일: 2026-08-27.

## 1. 태스크별 커밋

| Task | 커밋 | 제목 | 모델 |
|---|---|---|---|
| T1 | `5e0a6c7` | feat(core): 추정기 v2 공유 계약과 서버 instructions 오버헤드 저장을 추가한다 | sonnet |
| T2 | `f93bdc6` | feat(core): 툴 정의 토큰을 실측 배율로 보정하고 서버 instructions를 센다 | sonnet |
| T3 | `38ffe52` | feat(core): 서버 제거와 툴 필터의 절감을 instructions 오버헤드로 가른다 | opus |
| T4 | `52ebd9e` | feat(t4): 스캔 오버헤드를 저장과 리포트 입력까지 배선한다 | sonnet |

### 변경 파일

**T1** (공유 계약)
- `packages/core/src/types.ts` (`EstimatorVersion`, `ToolDefinition.advertisedTokens`·`estimatorVersion`, `ServerContextOverhead`)
- `packages/core/src/store/schema.sql` (`tool_definitions` 컬럼 2개, 신규 테이블 `server_context_overheads`)
- `packages/core/src/store/store.ts` (`migrate()` 2블록, `upsertDefinitions`·`allDefinitions` 확장, `upsertServerContextOverheads`·`allServerContextOverheads` 신설)
- `packages/core/test/store/estimatorV2.test.ts` (신규 4건)
- 기존 `ToolDefinition` 픽스처 갱신: `codex-load-attribution.test.ts`, `codex-tool-name.test.ts`, `observations.test.ts`, `outputSchemaContract.test.ts`, `store.test.ts`, `v2Contracts.test.ts`, `writerGuard.test.ts`

**T2** (스캐너 보정)
- `packages/core/src/scanner/calibration.ts` (신규)
- `packages/core/src/scanner/scanner.ts`
- `packages/core/test/scanner/calibration.test.ts` (신규 6건)
- `packages/core/test/scanner/outputSchema.test.ts`
- `packages/core/test/fixtures/calibration/day-01.json` (신규, `docs/plans/assets/2026-08-27-보정-근거-day-01.json` 사본. `diff`로 동일성 확인)

**T3** (귀속)
- `packages/core/src/engine/cost.ts`, `packages/core/src/engine/engine.ts`
- `packages/core/src/report/rollup.ts`, `packages/core/src/report/model.ts`
- `packages/core/test/report/rollup.test.ts`
- `packages/core/test/report/instructionsAttribution.test.ts` (신규 4건)

**T4** (배선)
- `packages/core/src/store/store.ts` (`upsertScanResult`에 선택 인자 `overhead`)
- `packages/cli/src/scan-run.ts`, `packages/cli/src/auth-rescan.ts`
- `packages/extension/src/autoScan.ts`, `packages/extension/src/extension.ts`
- `packages/core/test/store/estimatorV2.test.ts`, `packages/cli/test/scan-run.test.ts`, `packages/extension/test/autoScan.test.ts`, `packages/dashboard/test/server.test.ts`

## 2. 검증 명령 실제 출력

오케스트레이터가 T4 통합 후 직접 재실행한 결과다 (2026-08-27 14:37, HEAD `52ebd9e`).

```
$ npm run build -w @mcp-lens/core
> @mcp-lens/core@0.1.0 build
> tsc -p tsconfig.json && cp src/store/schema.sql dist/store/
```

```
$ npx tsc --noEmit -p packages/core/tsconfig.json;      echo "core exit=$?"
$ npx tsc --noEmit -p packages/cli/tsconfig.json;       echo "cli exit=$?"
$ npx tsc --noEmit -p packages/extension/tsconfig.json; echo "extension exit=$?"
core exit=0
cli exit=0
extension exit=0
```

세 개 모두 출력 없이 종료했다. `-p` 없이 `npx tsc --noEmit`만 치면 0개 파일을 검사하고 성공하므로
판정에 쓰지 않았다.

```
$ npm test
   ✓ scanner v2 calibration > excludes outputSchema from the token count 885ms
   ✓ scanner v2 calibration > counts the fully qualified tool name 4059ms

 Test Files  119 passed (119)
      Tests  1357 passed (1357)
   Start at  14:37:47
   Duration  7.01s
```

기준선은 착수 시점 1340건이었다. 증분은 T1 4건, T2 6건, T3 4건, T4 3건이며 합계 1357건이다.

신규 테스트는 계획서 6절의 이름과 단언을 그대로 구현했고 줄이지 않았다.

- `packages/core/test/store/estimatorV2.test.ts`: `round-trips advertisedTokens and estimatorVersion`, `reads a pre-migration row as estimator version v1`, `round-trips a server context overhead`, `overwrites a server context overhead on rescan`
- `packages/core/test/scanner/calibration.test.ts`: `excludes outputSchema from the token count`, `counts the fully qualified tool name`, `calibrated tokens are the advertised tokens times the harness factor`, `stores zero instructions tokens when the server publishes none`, `matches the measured day-01 weights within 10 percent on average`, `the uncalibrated estimator would have failed the same bar`
- `packages/core/test/report/instructionsAttribution.test.ts`: `server removal saving includes the instructions overhead`, `tool filtering saving excludes the instructions overhead`, `filtering every tool still leaves the instructions overhead`, `a server with no instructions has identical removal and full-filter savings`

## 3. 픽스처 10서버 v2 오차

`packages/core/test/fixtures/calibration/day-01.json` 기준.
추정식은 `calibrate(advertisedTokens + instructionsTokens)`이고 `HARNESS_FACTOR = 1.608`이다.

| 서버 | 툴 | advertised | instructions | v2 추정 | 실측 | v2 오차 | v1 오차 |
|---|---|---|---|---|---|---|---|
| huggingface | 4 | 1,622 | 361 | 3,189 | 3,286 | 2.95% | 36.34% |
| awsknowledge | 5 | 1,873 | 0 | 3,012 | 3,160 | 4.68% | 41.90% |
| mslearn | 3 | 742 | 290 | 1,659 | 1,872 | 11.38% | 53.58% |
| context7 | 2 | 993 | 126 | 1,799 | 1,812 | 0.72% | 45.86% |
| deepwiki | 3 | 250 | 578 | 1,331 | 1,166 | 14.15% | 72.47% |
| cloudflare-docs | 2 | 266 | 0 | 428 | 486 | 11.93% | 20.16% |
| svelte | 4 | 1,127 | 50 | 1,893 | 1,845 | 2.60% | 33.88% |
| memory | 9 | 949 | 0 | 1,526 | 1,653 | 7.68% | 20.75% |
| filesystem | 14 | 1,735 | 0 | 2,790 | 2,949 | 5.39% | 20.24% |
| sequential-thinking | 1 | 861 | 0 | 1,384 | 1,227 | 12.80% | 22.74% |
| **평균 절대오차** | | | | | | **7.43%** | **36.79%** |

평균 7.43%는 픽스처의 `meanV2ErrorRate`(0.0743)와 소수 3자리까지 같고, v1 평균 36.79%도
`meanV1ErrorRate`(0.3679)와 같다. 계획서 1절의 완료 조건인 "평균 절대오차 10% 미만"을
만족한다. 최악은 deepwiki 14.15%, 최선은 context7 0.72%다.

## 4. 계획서와 다르게 한 판단

- **`ToolDefinition.advertisedTokens`를 `number`가 아니라 `number | null`로 했다** (T1).
  마이그레이션 전 행은 컬럼 자체가 없어 백필할 진실이 없고, 계획서 6절의
  `reads a pre-migration row as estimator version v1`이 `null`을 기대한다. `number`로 두면
  타입과 런타임 값이 어긋난다.
- **`scanServer`의 반환에 `overhead` 필드를 추가했다** (T2). `scanner.ts`는 store를 import하지
  않는 순수 함수라 저장할 자리가 없었다. 기존 `{ definitions, bodies }` 패턴을 따라 반환만
  하고, 저장 배선은 T4로 넘겼다.
- **`coversEveryTool`의 분모를 `visible`이 아니라 전체 행으로 잡았다** (T3). deferred 모드에서
  숨겨진 툴이 있으면 그 그룹은 서버 전체를 끄는 것이 아니므로 instructions를 가져가지 못한다.
  절감을 과대평가하지 않는 보수적 방향이며 저장소의 하한 추정 원칙과 같다.
- **`cumulativeCost`와 `sessionSavings`는 손대지 않았다** (T3). 전자는 툴 단위 누적 비용이라
  서버 오버헤드가 귀속될 자리가 없고, 후자는 로드 이벤트와 정의를 대조하는 계산이라
  instructions를 넣으면 비교 집합이 어긋난다. 귀속의 자리는 리포트 그룹이다.
- **`MatrixRow`에 필드를 넣지 않았다** (T3). `types.ts`가 공유 계약이라 T3이 손댈 수 없어,
  서버 툴 수를 `rollupClient`가 받은 rows에서 직접 센다.
- **UI 문구는 하나도 바꾸지 않았다.** 계획서 1절이 비범위로 못 박았다. 숫자의 출처만 바뀐다.

## 5. 실행 중 드러난 것

### 5.1 배선이 두 태스크 사이에 끼어 누락될 뻔했다

T2는 `overhead`를 반환만 하고, T3은 `EngineInput.serverOverheads`를 읽기만 했다. 그 사이를
잇는 구간이 어느 태스크의 Files 목록에도 없었다. T2·T3 통합 직후 상태는 타입체크와 테스트가
전부 녹색이면서 실제 리포트 수치는 오버헤드가 빈 배열이라 이전과 같았다. 계획서 6절 테스트는
스텁 입력으로 귀속 규칙만 검증하므로 이 구멍을 잡지 못한다. T4의 범위를 배선까지 넓혀 닫았고,
`upsertScanResult`와 `allServerContextOverheads` 양쪽에 회귀 테스트를 붙였다.

교훈은 계획서의 Files 분할이 데이터 흐름의 양끝만 나눠 갖고 중간을 아무도 소유하지 않으면
"전부 녹색인데 아무 일도 안 일어남" 상태가 만들어진다는 것이다.

### 5.2 worktree의 `node_modules` 심링크가 낡은 core를 가리켰다

T4가 발견했다. 이 worktree의 `node_modules`는 루트 저장소의 `node_modules`를 통째로 가리키는
심링크였고, 그 안의 `@mcp-lens/core`는 상대 심링크 `../../packages/core`라 결과적으로
**루트 저장소의** `packages/core`(T1 이전 상태의 낡은 `dist`)를 가리켰다. 그래서
`@mcp-lens/core`를 패키지 이름으로 import하는 cli·extension의 타입체크와 테스트는 이 worktree의
T1~T3 변경을 아예 보지 못했다.

T4가 `node_modules`를 실제 디렉터리로 바꾸고 `@mcp-lens/core`·`cli`·`dashboard`만 이 worktree의
`packages/*`로 다시 심링크했다. 나머지 서드파티는 루트 것을 재심링크했다. `node_modules`는
gitignore 대상이라 커밋에는 잡히지 않는다.

이 조치 이후에야 `packages/dashboard/test/server.test.ts`의 진짜 결함이 드러났다. 그 테스트의
`upsertDefinitions` 픽스처가 T1이 필수로 만든 `advertisedTokens`·`estimatorVersion`을 채우지
않아 `undefined`가 sql.js에 바인딩되며 실패했다. tsc는 테스트 파일을 보지 않으므로 타입
에러로는 잡히지 않는 경우이며, CLAUDE.md의 알려진 함정과 정확히 같다.

**이 문제는 이 worktree 밖에도 있을 가능성이 높다.** 근본 원인은 루트 저장소의
`packages/core/dist`가 낡아 있는 것이므로 다른 병렬 worktree도 같은 착시를 볼 수 있다.
`npm test` 녹색을 판정에 쓰기 전에 `node_modules/@mcp-lens/core`가 어디를 가리키는지 확인하는
것을 머지 게이트 체크리스트에 넣을 것을 권한다.

### 5.3 CLI와 대시보드는 서버 단위 절감을 애초에 표시하지 않는다

`serverOverheads`를 읽는 곳은 `packages/core/src/report/rollup.ts:103`의 `rollupClient` 하나뿐이고,
그 진입점은 `buildReport`다. `buildMatrix`(engine.ts:40)와 `sessionSavings`(engine.ts:103)는
`serverOverheads`를 읽지 않는다.

그런데 `packages/cli/src/main.ts:116`과 `packages/dashboard/src/server.ts:156`은 둘 다
`buildMatrix` + `sessionSavings`만 쓴다. 두 면의 출력은 툴 단위 `MatrixRow` 표와
`potential/actual/saved` 세 숫자이며, 서버 단위 절감이라는 항목 자체가 없다. 따라서 이 두 곳에
`serverOverheads`를 넘겨도 읽는 코드가 없어 수치가 한 자리도 바뀌지 않는다.

두 면이 "v1 수치를 낸다"는 표현은 정확하지 않다. 툴별 `definitionTokens`는 스캐너가 저장하는
값이므로 재스캔 이후에는 보정된 v2 값이다. 빠져 있는 것은 서버 단위 instructions 귀속뿐이고,
그것은 이 두 면이 원래 표시하지 않던 항목이다.

실제로 반영하려면 CLI와 대시보드를 `buildMatrix`에서 `buildReport` 경로로 옮겨야 하며, 그것은
출력 형태와 문구를 바꾸는 일이라 계획서 1절이 비범위로 못 박은 "대시보드·확장 UI의 문구를
바꾸지 않는다"에 정면으로 걸린다. 이 계획에서 하지 않고 5절 후속으로 넘기는 것이 맞다고 본다.

현재 서버 단위 귀속이 실제로 반영되는 면은 확장의 리포트 경로
(`packages/extension/src/extension.ts:362`, `:729`)다.

## 6. 남은 위험

- **재스캔 전까지는 v1 값이 남는다.** 마이그레이션은 컬럼만 추가하고 백필하지 않는다.
  기존 행은 `estimatorVersion = 'v1'`, `advertisedTokens = NULL`로 읽힌다. 의도한 동작이며
  거짓 정밀도를 만들지 않기 위한 것이지만, 사용자가 재스캔하기 전에는 리포트가 v1 수치를
  보인다는 뜻이다.
- **`extension.ts`의 `serverOverheads` 배선 두 곳에 전용 회귀 테스트가 없다.** `activate` 전체를
  감싸는 파일이고 vscode를 모킹하는 하네스가 없다. `EngineInput` 생성부가 그 파일 안에 두 곳뿐이라
  소스 검사로 확인했으나, 향후 세 번째 생성부가 생기면 놓칠 수 있다. `serverOverheads`가
  optional 필드라 컴파일이 막아주지 않는다.
- **CLI·대시보드의 서버 단위 귀속 미반영** (5.3절). 같은 DB를 보는 세 면 중 확장만 서버 단위
  귀속을 반영한다. 후속 태스크가 필요하다.
- **배율 1.608의 표본이 10개다.** 출처는 Claude Code eager 모드 하나이며, Codex·Gemini CLI는
  같은 배율을 쓰고 그 사실을 `CALIBRATION_SOURCE`로 밝힌다. 배치가 쌓이면 재적합해야 하고,
  그때 상수와 주석의 오차 수치를 같이 갱신해야 한다.
- **실 환경 스모크를 돌리지 않았다.** 전부 픽스처와 `:memory:` DB다. 계획서가 실 서버·실 DB를
  만지지 않도록 정한 대로이나, 스키마가 바뀌었으므로 머지 후 실 클라이언트 로그와 실 DB로
  스모크를 한 번 돌리는 것이 맞다.
