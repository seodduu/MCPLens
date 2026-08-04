---
name: completing-wave-tasks
description: Use when a user reports that a numbered implementation-plan task or Wave prompt is complete and expects its worktree to be reviewed, verified, committed, merged into main, and cleaned up.
---

# Wave 태스크 완료 처리

완료 보고는 통합 요청으로 취급한다. 구현자 보고서는 단서일 뿐이며, 새 검증 증거 없이 `main`에 넣지 않는다.

## 태스크 식별

1. 사용자가 지정한 계획서를 연다. “Wave N의 M번째 프롬프트”는 해당 프롬프트의 태스크 매핑으로, “Task N”은 해당 heading으로 해석한다.
2. 태스크의 `Files`, 선행조건, 테스트·typecheck·build·UI/실기기 요구를 읽는다. `git worktree list --porcelain`와 계획서로 브랜치·worktree를 찾고, 보고서는 검증 단서로만 사용한다.
3. `main`의 선행조건을 확인한다. 의존 태스크보다 먼저 커밋·병합하지 않는다. 공유 계약 불일치, 필수 산출물 누락, 범위 확장이 보이면 중단하고 근거를 보고한다.

## 검증과 커밋

1. 태스크 worktree에서 `git status --short`, `git diff --check`를 실행하고 모든 변경 경로를 `Files` 목록과 대조한다. 허용된 태스크 파일만 stage하며 생성물·무관한 변경·기존 사용자 변경은 절대 포함하지 않는다.
2. diff를 읽고 계획서의 정확한 테스트 명령을 다시 실행한다. 영향 패키지마다 `npx tsc --noEmit -p packages/<패키지>/tsconfig.json`을 실행하고, 요구되면 build·스크린샷·실기기 증거도 확인한다. 의존성은 없고 lockfile이 있을 때만 설치한다.
3. 테스트·typecheck·시각 검증·범위·선행조건 중 하나라도 실패하면 커밋·병합·정리를 하지 않는다. 명령 출력과 blocker를 보고한다.
4. 모든 증거가 녹색일 때만 커밋한다. 계획서의 커밋 메시지를 우선하되 저장소의 언어 규칙을 따른다. 하나의 worktree에 Task 5 → 6처럼 의존 태스크가 함께 있으면 각 allowlist로 순서가 있는 별도 커밋을 만든다.

## 병합과 정리

1. primary checkout에서 기존 dirty path를 보존하고 `--no-ff`로 병합한다. reset, stash, clean, 무관한 pull은 하지 않는다.
2. 병합된 `main`에서 `npm test`와 영향 typecheck를 새로 실행한다. 태스크나 프로젝트 완료 조건이 요구할 때만 workspace build도 실행하고 출력을 읽는다.
3. 병합 검증이 통과한 뒤에만 해당 worktree가 깨끗한지 확인하고, 그 정확한 worktree를 제거·prune한 후 병합된 해당 브랜치만 삭제한다. 다른 worktree·브랜치·사용자 변경은 건드리지 않는다.

| 상태 | 처리 |
| --- | --- |
| 태스크와 병합 후 검증이 모두 통과 | 커밋 → 병합 → 정리 |
| 태스크 검증 또는 범위가 실패 | worktree와 브랜치를 보존하고 blocker 보고 |
| 병합 후 검증 실패 | 정리하지 않고 원인 진단 |
