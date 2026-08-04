---
name: execution-conventions
description: Execute an approved MCP Lens implementation plan with worktrees, native subagents, integration gates, and real-environment E2E preflight. Use when starting or resuming a Wave, creating task worktrees, spawning implementation, review, or verifier agents, merging task results, or running Task 14-style validation.
---

# MCP Lens 실행 규약

## Wave 시작과 통합

1. 계획서의 Wave 표, 태스크 의존성, 허용 Files를 읽는다.
2. worktree나 실행 프롬프트를 만들기 전에 즉시 병렬로 시작할 task, 각 선행 task, 정확한 merge gate를 사용자에게 commentary로 선언한다.
3. 선행 태스크의 integration SHA가 docs/task-integration-ledger.tsv에 있고 commit object로 존재하며 현재 HEAD의 조상인지 git cat-file -e와 git merge-base --is-ancestor로 확인한다. branch나 worktree 존재를 완료 근거로 쓰지 않는다.
4. 실패하면 실패 task·integration SHA·검증 결과를 포함해 BLOCKED로 보고하고 후속 worktree 생성, 프롬프트 작성, spawn, 수정, commit, merge, push를 하지 않는다.
5. 통과하면 현재 HEAD를 base로 기록하고 task마다 독립 worktree 하나와 브랜치 하나를 만든다.
6. task 통합 직후 SHA를 대장에 기록하고 별도 문서 commit으로 보존한다. 대장에 없는 결과는 후속 태스크의 선행 근거로 쓰지 않는다.

## Worktree bootstrap

1. git rev-parse --git-dir, git rev-parse --git-common-dir, git branch --show-current로 연결 worktree인지 판별한다. 이미 격리된 worktree에서는 중첩 worktree를 만들지 않는다.
2. 새 worktree를 만들기 전에 계획서와 참조 문서가 commit에 포함됐는지 확인한다. untracked면 먼저 별도 문서 commit으로 보존하고, gitignore 대상이면 계획에 명시된 경로로 생성 직후 복사한다.
3. worktree에 들어가 pwd, git log --oneline -1, base HEAD 일치, 설계·계획 문서 존재, git status --short를 확인한다.
4. 새 worktree는 gitignore된 node_modules를 상속하지 않음을 전제한다.
5. 프로젝트 bootstrap을 사용한다. 없으면 계획서에 명시한 root node_modules read-only symlink 또는 npm ci를 사용한다.
6. agent spawn 전에 node_modules/.bin/vitest, node_modules/.bin/tsc, 필요한 build 도구가 실행 가능한지 확인한다.
7. 기점·문서·bootstrap·도구 확인이 하나라도 실패하면 구현·리뷰·E2E agent를 spawn하지 않고 BLOCKED로 보고한다.
8. report에는 pwd, git rev-parse HEAD, base commit, 실제 의존성 경로, 실행한 검증 명령과 결과를 기록한다.

## Native subagent 운영

- 구현 계획은 subagent-driven development 흐름으로 실행하며 메인 세션은 요구사항·분할·통합·리뷰·최종 검증을 소유한다.
- 구현·테스트·리뷰·검증 자식은 native spawn_agent로만 생성한다. codex exec는 제품 기능이 외부 Codex CLI를 호출할 때만 쓴다.
- agent_type은 default로 하고 model, reasoning_effort, 역할, Task, worktree, 허용 Files, 테스트, report 경로를 message에 명시한다. 계획이 역할 TOML을 지정하면 경로를 먼저 읽게 한다. 고정 역할명은 모델 배분 수단으로 쓰지 않는다.
- 자식 message에는 background 실행, commit, merge, push, 하위 agent spawn 금지와 다른 작업자의 변경을 되돌리지 말라는 지시를 포함한다.
- 활성 자식마다 agent ID, task명, 기대 report 경로, 상태를 추적하고 최대 60초마다 wait_agent로 이벤트를 확인한다.
- 완료 메시지를 받으면 다음 구현·리뷰·통합 전에 사용자에게 agent ID, 상태, 변경 파일, 검증 결과, report 경로, 다음 조치를 commentary로 보고한다.
- report, 허용 Files diff, 테스트 결과를 확인하기 전에는 결과를 통합하거나 후속 태스크를 시작하지 않는다.
- 자식 최종 응답은 status: READY_FOR_REVIEW 또는 status: BLOCKED로 시작하고 변경 파일, 검증 명령·결과, report 경로, 남은 위험을 포함한다.
- 여러 자식이 동시에 완료되면 하나의 commentary로 묶을 수 있지만 다음 제어 지점보다 늦게 보고하지 않는다.

## 모델 선택

기본 reasoning effort는 medium이다.

- gpt-5.6-luna: 범위가 좁고 명확한 읽기 전용·반복 저위험 작업. 설계 판단과 shared contract 수정은 금지한다.
- gpt-5.6-terra: 오케스트레이션, 일반 구현·테스트·디버깅·리뷰·통합.
- gpt-5.6-sol: 아래 승급 조건 중 하나가 있을 때 남은 불확실성 판정 범위에만 사용한다.

- client adapter·log parser, 토큰 회계·절감 산출, lazy loading mode, writer lease처럼 실패 비용이 큰 영역에서 사양·fixture·Terra 검토 후에도 구체적 불변식·동시성·규칙 충돌이 남는다.
- 서로 다른 접근을 포함한 Terra 시도 두 번이 같은 불확실성을 남기거나 구현자와 reviewer 판정이 충돌한다.
- 사용자가 Sol 사용을 명시한다.

Sol을 쓰면 승급 사유·판정 범위·해소할 불확실성을 계획과 report에 적고, 판정 뒤 구현·회귀는 Terra로 되돌린다. 파일 수나 최종 리뷰라는 이유만으로 승급하지 않는다. Luna가 범위 밖 판단이나 shared contract 수정을 요구하면 Terra로 승급한다. Luna를 쓸 수 없으면 Terra로 대체하며 Sol로 대체하지 않는다. native spawn에는 reasoning_effort를, 독립 agent TOML에는 model_reasoning_effort를 사용한다. AGENTS.md는 이미 시작된 메인 세션의 모델을 바꾸지 않는다.

## Merge 직전 재확인

- schema를 건드렸으면 main의 현재 migration 최대 번호를 다시 확인한다. 빈 DB unit test 통과만으로 번호 역전이 없다고 판단하지 않는다.
- 화면 결함은 관련 산출물을 재빌드한 뒤 다시 확인한다.
- typecheck는 package별 -p로 실행하고 전체 판정은 npm test로 한다.

## 실환경 E2E

- 실제 사용자 설정, 공유 DB, 실제 MCP 서버 E2E는 직렬 Wave에서만 수행한다.
- 먼저 read-only preflight로 plugin/hook healthy, identity clear, 사용자가 지정한 저비용·안전 MCP test tool, 설정·DB fingerprint와 backup 계획을 확인한다.
- 하나라도 불명확하면 mutation 없이 BLOCKED다.
- 실제 mutation은 메인 오케스트레이터만 수행한다. finally에서 원본 fingerprint와 복구 상태를 대조한다.
