# Wave 10 터미널 프롬프트 (복붙용)

계획: `docs/plans/2026-07-20-리포트-가독성-구현계획.md`
설계: `docs/designs/2026-07-20-리포트-가독성-설계.md`

**선행 완료:** Task 33(공유 계약)은 main에 머지됨 (`b1231ef`, 276 tests green).
`Recommendation.reasonParts`와 `packages/core/src/report/{model,index}.ts`가 이미 존재한다.

**워크트리는 이미 생성돼 있다.** 각 터미널에서 아래 경로로 이동만 하면 된다.

| 터미널 | 태스크 | 워크트리 | 브랜치 |
|---|---|---|---|
| T1 | Task 34 engine reasonParts | `../MCPLens-wt/report-engine-parts` | `feat/report-engine-parts` |
| T2 | Task 35 롤업 | `../MCPLens-wt/report-rollup` | `feat/report-rollup` |
| T3 | Task 36 마크다운 렌더러 | `../MCPLens-wt/report-markdown` | `feat/report-markdown` |
| T4 | Task 37 extension 배선 | `../MCPLens-wt/report-ext` | `feat/report-ext` |

각 터미널에서 해당 워크트리로 `cd` 후 `claude` 실행, 아래 코드 블록을 그대로 붙여넣는다.
4개 세션이 모두 끝나면 메인 터미널에서 머지를 요청한다 (T1 → T2 → T3 → T4 순).

**T2·T3는 `packages/core/src/report/index.ts`의 서로 다른 줄을 수정한다** — 계획된 충돌이며
메인 터미널이 머지 시 양쪽 re-export를 모두 남기는 방식으로 해소한다. 각 터미널은 신경 쓰지 않는다.

---

## T1 — Task 34 engine reasonParts

```text
너는 MCP Lens 프로젝트 Wave 10의 T1 오케스트레이터야.

작업 공간은 이미 격리돼 있어: /Users/doo._.hyun/Study/Project/MCPLens-wt/report-engine-parts
(브랜치 feat/report-engine-parts, main에서 분기). 여기서 npm install 먼저 실행해.

docs/plans/2026-07-20-리포트-가독성-구현계획.md 의 "## 2. Task 34"만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해. 서브에이전트 모델은 sonnet.

배경: showReport가 실데이터 200줄을 평면 나열하는데 조치 가능 항목은 3개뿐이야.
서버 공통 근거("서버 notion의 20툴 중 2개만 사용")가 툴마다 reason에 통째로 복제돼
notion만 10줄이 거의 같은 문장이야. Task 33이 이미 Recommendation.reasonParts를
추가하고 engine.ts에 placeholder(flatParts — basis=reason, 나머지 null)를 채워놨어.
네 일은 그 placeholder를 진짜 분해로 교체하는 거야. 병렬 터미널이 이걸 소비하는
롤업·렌더러를 만드는 중이지만 파일이 갈려 있어 서로 안 보여도 돼.

소유 파일은 딱 4개야: packages/core/src/engine/engine.ts, engine/evidence.ts,
packages/core/test/engine/engine.test.ts, test/engine/evidence.test.ts.
types.ts, schema.sql, report/, extension/, cli/는 절대 수정하지 마 — 공유 계약이거나
다른 터미널 소유야. 밖의 파일을 고쳐야 할 것 같으면 수정하지 말고 보고해.

가장 중요한 제약: 최종 reason 문자열이 모든 분기에서 지금과 바이트 단위로 동일해야 해.
CLI 테이블·트리 tooltip·JSON이 전부 이걸 소비하거든. 계획서 Step 1의 동일성 회귀
테스트를 리팩터링 전에 먼저 세워. 기존 테스트의 기대 문자열을 고치고 있다면 멈춰 —
그건 reason이 바뀐 거고, 낡은 테스트가 아니라 네 구현이 틀린 거야.

계획서의 joinReason 구분자 규칙은 스케치일 뿐 확정이 아니야. 현행 recommend()의
sizePhrase·pollutionSuffix·tail은 분기마다 공백·구분자가 제각각이라, 바이트 동일성이
성립할 때까지 joinReason과 parts 경계를 조정해. CLAUDE.md 원칙대로 계획서와 코드가
다르면 코드가 진실이야.

action·confidence·evidence·evidenceLabel 값은 하나도 바뀌면 안 돼. 판정 로직은
그대로고 reason 조립 방식만 리팩터링하는 거야. core에 vscode import 금지,
유닛테스트는 픽스처와 :memory: DB만.

완료 기준: 워크트리 루트에서 npm test 전부 통과(276개 이상) + packages/core에서
npx tsc --noEmit -p tsconfig.json exit 0 + 기존 테스트 단정문을 수정하지 않았음을
git diff로 확인 + feat/report-engine-parts에 커밋 완료.
커밋 메시지는 한국어로 저장소 스타일에 맞추고 끝에
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com> 를 붙여.
끝나면 커밋 SHA와 테스트 결과, 최종 joinReason 규칙이 계획서 스케치와 어떻게 달라졌는지
보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
```

---

## T2 — Task 35 롤업 (EngineInput → ReportModel)

```text
너는 MCP Lens 프로젝트 Wave 10의 T2 오케스트레이터야.

작업 공간은 이미 격리돼 있어: /Users/doo._.hyun/Study/Project/MCPLens-wt/report-rollup
(브랜치 feat/report-rollup, main에서 분기). 여기서 npm install 먼저 실행해.

docs/plans/2026-07-20-리포트-가독성-구현계획.md 의 "## 3. Task 35"만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해. 서브에이전트 모델은 sonnet.

배경: showReport가 정의 토큰 크기순으로 200줄을 평면 나열해서 못 읽어. 이걸 조치 중심
리포트로 바꾸는 중이고, 너는 집계 절반(EngineInput → ReportModel)을 맡아. 병렬 터미널이
네 ReportModel을 소비하는 마크다운 렌더러를 만드는 중이야. 네가 만들 타입은 이미 확정돼
있으니 packages/core/src/report/model.ts를 무엇보다 먼저 읽어.

집계 규칙(버킷 배정·클라이언트 접기·정렬)의 확정 사양은
docs/designs/2026-07-20-리포트-가독성-설계.md 의 §4-2, §4-3, §4-4야. 이 세 절을 읽어.
계획서의 테스트 목록은 최소선이지 상한이 아니야.

계획서가 살짝 틀린 두 가지 — 내 판단을 따라:
1. 계획서는 hasUnmeasured 필드를 추가하고 보고하라고 하는데, 이미 model.ts에 있어.
   채우기만 하면 되고 편차로 보고할 필요 없어.
2. ClientReport에 unmeasuredToolCount(action='unknown' 행 수)도 있는데 계획서에 언급이
   없어. 채워. unknown 행은 어느 버킷에도 안 넣고 여기서만 센다.

생성은 packages/core/src/report/rollup.ts 와 packages/core/test/report/rollup.test.ts
두 개만. 수정은 packages/core/src/report/index.ts 한 곳만 — buildReport 스텁을
export { buildReport } from './rollup.js'; 로 교체하고 renderReport 스텁은 손대지 마
(다른 터미널 소유야). model.ts, types.ts, engine/, schema.sql은 수정 금지.
타입이 진짜로 막으면 고치지 말고 보고해.

중요: 테스트 픽스처는 MatrixRow 객체를 손으로 만들어. buildMatrix()를 호출하지 마.
병렬 터미널이 지금 engine.ts의 reasonParts 내용을 바꾸는 중이라 그 출력에 의존하면
타이밍에 묶여. 손으로 만든 행이 너를 독립적으로 유지해줘.

클라이언트 분할과 숨김 툴 계수는 engine/engine.js의 기존 splitByClient·visibleMatrixRows를
재사용해 — hiddenToolCount는 현행 packages/extension/src/extension.ts:137-138 동작과
일치해야 해. core에 vscode import 금지, 유닛테스트는 픽스처와 :memory: DB만. TDD로.

완료 기준: 워크트리 루트에서 npm test 전부 통과 + packages/core에서
npx tsc --noEmit -p tsconfig.json exit 0 + feat/report-rollup에 커밋 완료.
커밋 메시지는 한국어로 저장소 스타일에 맞추고 끝에
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com> 를 붙여.
끝나면 커밋 SHA와 테스트 결과, 사양 모호성을 해소한 지점을 보고하고 머지는 하지 마 —
머지는 메인 터미널이 담당해.
```

---

## T3 — Task 36 마크다운 렌더러 (ReportModel → 마크다운)

```text
너는 MCP Lens 프로젝트 Wave 10의 T3 오케스트레이터야.

작업 공간은 이미 격리돼 있어: /Users/doo._.hyun/Study/Project/MCPLens-wt/report-markdown
(브랜치 feat/report-markdown, main에서 분기). 여기서 npm install 먼저 실행해.

docs/plans/2026-07-20-리포트-가독성-구현계획.md 의 "## 4. Task 36"만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해. 서브에이전트 모델은 sonnet.

배경: showReport가 정의 토큰 크기순으로 200줄을 평면 나열해서 못 읽어. 이걸 조치 중심
역피라미드로 바꾸는 중이고, 너는 렌더링 절반(ReportModel → 마크다운)을 맡아. 병렬
터미널이 네가 받을 ReportModel을 만드는 중이지만 너는 기다리지 마 — 타입이 이미
확정돼 있으니 ReportModel을 손으로 만들어 넣고 TDD해. model.ts를 먼저 읽어.

목표 출력의 유일한 사양은 docs/designs/2026-07-20-리포트-가독성-설계.md 의 §3이야.
그 예시를 그대로 재현해. 절단·서식 정책은 §5.

생성은 packages/core/src/report/markdown.ts 와
packages/core/test/report/markdown.test.ts 두 개만. 수정은
packages/core/src/report/index.ts 한 곳만 — renderReport 스텁을
export { renderReport } from './markdown.js'; 로 교체하고 buildReport 스텁은 손대지 마
(다른 터미널 소유야). model.ts, types.ts, engine/, schema.sql은 수정 금지.

핵심 제약 몇 가지:
- HTML 태그(<details> 등) 쓰지 마. 이 리포트는 raw 마크다운 텍스트로 열리고 AI에게
  통째로 붙여넣는 게 제품 용도라 HTML은 순손해야.
- summary 모드 절단은 candidate·healthy 버킷에만. act와 inspect는 절대 절단하지 마.
- 1000 이상은 천단위 구분자. 정의 토큰은 항상 "세션당"을 명시해 — 누적값과 혼동되면
  절감량을 100배 과대평가하게 돼.
- now는 opts.now ?? new Date().toISOString()로 주입 가능하게 해서 테스트 결정성 확보.
- 접힌 클라이언트(collapsed)는 3줄 이내로.

core에 vscode import 금지, 유닛테스트는 픽스처와 :memory: DB만. TDD로.

완료 기준: 워크트리 루트에서 npm test 전부 통과 + packages/core에서
npx tsc --noEmit -p tsconfig.json exit 0 + feat/report-markdown에 커밋 완료.
커밋 메시지는 한국어로 저장소 스타일에 맞추고 끝에
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com> 를 붙여.
끝나면 커밋 SHA와 테스트 결과, 설계 §3 예시에서 벗어난 부분이 있다면 그 이유를
보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
```

---

## T4 — Task 37 extension 배선

```text
너는 MCP Lens 프로젝트 Wave 10의 T4 오케스트레이터야.

작업 공간은 이미 격리돼 있어: /Users/doo._.hyun/Study/Project/MCPLens-wt/report-ext
(브랜치 feat/report-ext, main에서 분기). 여기서 npm install 먼저 실행해.

docs/plans/2026-07-20-리포트-가독성-구현계획.md 의 "## 5. Task 37"만 수행해.
superpowers:subagent-driven-development 스킬로 태스크를 fresh 서브에이전트에 맡기고,
완료되면 테스트 통과와 파일 소유권 준수를 리뷰해. 서브에이전트 모델은 sonnet.

배경: packages/extension/src/extension.ts:129-148의 showReport 핸들러가 마크다운을
인라인으로 조립하는데, 실데이터 200줄 중 조치 가능 항목이 3개뿐이라 못 읽어. core에
buildReport/renderReport라는 새 표면이 생겼고(현재는 throw하는 스텁, 병렬 터미널이
실물을 만드는 중), 너는 그 인라인 블록을 새 표면 호출로 교체하는 배선을 맡아.

중요: buildReport/renderReport는 지금 스텁이라 호출하면 throw해. 그래서 네 테스트는
그 둘을 vi.mock으로 대체하고 배선만 검증해 — 설정값이 ReportOptions로 제대로
전달되는지. 실물 동작 검증은 Wave 2에서 메인 터미널이 실DB 스모크로 해.

소유 파일: packages/extension/src/reportCommand.ts (신규, vscode import 금지 —
테스트 가능한 순수 부분), packages/extension/src/extension.ts (showReport 핸들러 교체),
packages/extension/package.json (mcpLens.reportDetail 설정 추가),
packages/extension/test/reportCommand.test.ts (신규).
matrixTree.ts, lensTreeProvider.ts, statusBar.ts는 절대 수정하지 마 — 트리는 이번
Wave 범위 밖이야. core/, cli/도 수정 금지. 계약이 안 맞으면 수정하지 말고 보고해.

reportDays가 0 이하면 1로 보정하는 현행 규칙(extension.ts:31)을 승계해.
reportDetail 기본값은 summary. 인라인 블록을 지운 뒤 extension.ts에서 더 이상 안 쓰이는
import(splitByClient, visibleMatrixRows 등)를 정리하되, refresh()가 쓰는 것까지 지우지
않도록 실제 사용처를 확인해. vscode import는 이 패키지 안에서만 허용.

완료 기준: 워크트리 루트에서 npm test 전부 통과 + packages/extension에서
npx tsc --noEmit -p tsconfig.json exit 0 + feat/report-ext에 커밋 완료.
커밋 메시지는 한국어로 저장소 스타일에 맞추고 끝에
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com> 를 붙여.
끝나면 커밋 SHA와 테스트 결과를 보고하고 머지는 하지 마 — 머지는 메인 터미널이 담당해.
```

---

## 머지 후 (메인 터미널)

4개 브랜치를 T1 → T2 → T3 → T4 순으로 머지한다.
T2·T3 머지 시 `packages/core/src/report/index.ts`가 충돌한다 — **계획된 충돌**이며
양쪽 re-export를 모두 남기고 스텁 함수 본문을 제거하는 방식으로 해소한다:

```ts
export * from './model.js';
export { buildReport } from './rollup.js';
export { renderReport } from './markdown.js';
```

머지 게이트는 계획서 §7 체크리스트를 따른다. 이후 Task 38(CLI 통합 + 실DB 스모크)은
공유 자원을 만지므로 메인 터미널에서 직렬로 수행한다.
