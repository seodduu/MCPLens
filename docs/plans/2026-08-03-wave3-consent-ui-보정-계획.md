# MCP Lens v2 Wave 3 — consent UI 보정 계획

**목표:** Task 14 실환경 E2E에서 재현된 consent 모달 상세 누락을 수정하고, 최초 외부 추론 전에 설계문서 §2-4와 §13의 비용·데이터 고지 전체가 실제 VS Code 모달에 렌더되는지 검증한다.

**선행 통합:** Task 12 `33c1f90`, Task 13 사양 보정 `2ef8ff11598110f751e5a263b1008ab4406a051b`이 현재 main HEAD의 조상이어야 한다.

**실행:** 직렬 단일 태스크. `gpt-5.6-terra / medium`, `.codex/agents/mcplens-implementer.toml`.

## 비범위

- `packages/core`의 비용 계산, 타입, DB schema, 저장소 계약은 수정하지 않는다.
- provider 선택, 추론 CLI, batch/cache 판정, 전역 조치와 Task 14 실환경 E2E 순서는 변경하지 않는다.
- 실제 `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.mcplens/lens.db`를 수정하지 않는다.
- consent 시각 검증에서는 `Accept`를 누르거나 외부 추론 CLI를 실행하지 않는다.

## Task 13-consent-remediation — consent 상세 렌더링과 회귀 테스트

**Worktree:** `/Users/doo._.hyun/Study/Project/MCPLens-V2-worktrees/task-13-consent-remediation`

**Branch:** `fix/v2-consent-modal`

**Files**

- Modify: `packages/extension/src/inferenceConsent.ts`
- Modify: `packages/extension/src/extension.ts`
- Modify: `packages/extension/test/inferenceConsent.test.ts`

### 입력·표시 계약

`ConsentDialogInput`은 provider/model과 함께 core의 `estimateInferenceCost` 반환값 중 다음 구조를 입력받는다. core 공개 계약은 수정하지 않고 extension 내부 구조 타입으로 받는다.

```ts
estimate: {
  inputTokens: { min: number; max: number };
  outputTokens: { min: number; max: number };
  totalUsd: { min: number; max: number };
  rateDate: string;
  disclaimer: string;
}
```

`buildConsentDialog`는 영어 `title`과 하나의 `detail` 문자열을 생성한다. 토큰은 `en-US` 천 단위 구분자를 사용하고 USD 범위는 작은 금액이 0으로 보이지 않도록 소수점 6자리로 표시한다. `detail`에는 다음 의미가 모두 실제 값과 함께 포함되어야 한다.

1. `Selected provider and model`
2. `Estimated input tokens`
3. `Estimated output tokens`
4. `Estimated API-equivalent cost`와 rate date
5. `Actual billing depends on your CLI account and plan` 및 core disclaimer
6. `Data sent for analysis`: MCP tool definitions와 session content를 제거한 aggregated usage statistics
7. `Data never sent for analysis`: prompts, tool inputs, tool outputs, source code, project paths, credentials
8. 같은 server definition set과 analysis rules version에서 cache를 재사용하고 definition/rule 변경 시 무효화한다는 조건
9. MCP Lens에서 언제든 consent를 철회할 수 있다는 안내

VS Code 호출은 다음 계약으로 고정한다.

```ts
showInformationMessage(
  dialog.title,
  { modal: true, detail: dialog.detail },
  'Accept',
)
```

`inferenceConsent.ts`에는 `vscode`를 import하지 않는다. prompt 함수를 의존성으로 받는 비동기 helper를 두고, 반환값이 정확히 `Accept`일 때만 `InferenceConsent`를 반환하며 Cancel/닫기에서는 `null`을 반환한다. `extension.ts`는 이 helper의 반환값이 non-null일 때만 `saveInferenceConsent`, `save`, 후속 `analysisCoordinator.analyze()`를 호출한다.

### 테스트 계약

- 기존 순수 dialog 테스트를 새 입력 구조로 갱신하고 provider/model, 입력·출력 토큰, 총 USD, rate date, 과금 주의, 전송·비전송 범위, cache 재사용·무효화, 철회를 모두 단언한다.
- prompt mock이 받은 인자를 검사해 `{ modal: true, detail: dialog.detail }`와 `Accept` 버튼이 실제 어댑터 경계에 전달되는지 검증한다.
- Cancel/닫기에서는 helper가 `null`을 반환하고, Accept에서만 provider/model과 시각이 일치하는 consent를 반환함을 검증한다.
- 신규 제품 UI 문자열에 한글이 없음을 검증한다.

### 검증

1. 수정 전 새 회귀 테스트를 실행해 consent 상세가 VS Code 호출에 전달되지 않는 실패를 확인한다.
2. `npm test -- --run packages/extension/test/inferenceConsent.test.ts packages/extension/test/analysisCoordinator.test.ts`
3. `npx tsc --noEmit -p packages/extension/tsconfig.json`
4. `npm test`
5. `npm run build`
6. `git diff --check`

### 시각 검증

- 재빌드된 extension을 격리 Extension Development Host에서 실행한다.
- 격리 `HOME`, `--user-data-dir`, `--extensions-dir`를 사용하고 실제 사용자 설정·공유 DB를 수정하지 않는다.
- consent 모달에서 `Accept`를 누르지 않고, provider/model, 입력·출력 토큰, API 환산 비용, 과금 주의, 전송·비전송 범위, cache 조건, 철회 안내가 실제로 보이는지 직접 확인한다.
- 스크린샷을 `/private/tmp/mcplens-v2-consent-remediation/screenshots/consent-modal-details.png`에 저장한다.
- 외부 Claude/Codex inference process가 시작되지 않았음을 확인한다.

### 완료 보고

`/private/tmp/mcplens-v2-consent-remediation-report.md`에 다음을 한국어로 기록한다.

- worktree 절대 경로, branch, base commit, HEAD
- 수정 파일과 Files 목록 일치 여부
- 실패 테스트와 수정 후 각 검증 명령의 실제 결과
- 시각 검증 환경, 스크린샷 절대 경로, 표시 항목 확인 결과
- 실제 사용자 설정·공유 DB 무변경과 inference process 0 근거
- 남은 위험

최종 상태는 `status: READY_FOR_REVIEW` 또는 `status: BLOCKED`로 시작한다. 구현 에이전트는 commit, merge, rebase, push, 하위 agent spawn, background 실행을 하지 않는다.

## 통합 gate와 Task 14 재개

메인 오케스트레이터는 report, 허용 Files diff, 표적 테스트, package별 타입체크, 전체 테스트·빌드, 스크린샷을 직접 검토한다. 모두 통과한 뒤 태스크 단위 한국어 commit으로 main에 통합하고 `docs/task-integration-ledger.tsv`에 `13-consent-remediation` integration SHA를 별도 문서 commit으로 기록한다.

Task 14는 이 ledger SHA가 commit object로 존재하고 새 main HEAD의 조상임을 확인한 뒤, 새 worktree와 새 branch에서 preflight부터 재실행한다.
