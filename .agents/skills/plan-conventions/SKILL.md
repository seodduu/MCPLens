---
name: plan-conventions
description: Create or modify MCP Lens design documents, implementation plans, task breakdowns, Wave graphs, and copy-paste execution prompts. Use when planning work or changing plan files under docs/plans; read execution-conventions too when the plan includes worktrees or subagents.
---

# MCP Lens 계획 작성 규약

계획은 작업자가 해석을 다시 하지 않아도 파일 경계, 공유 계약, 실행 순서, 모델, 통과 조건을 동일하게 이해하게 작성한다. 먼저 AGENTS.md, MCP-Lens-설계문서-v2.md, packages/core/src/store/schema.sql, packages/core/src/types.ts, 관련 fixtures를 읽는다.

## 작성 순서

1. 목표, 비범위, 완료 조건을 검증 가능한 문장으로 고정한다.
2. 관련 파일·symbol·테스트 명령을 실제 저장소에서 확인한다. 문서와 schema·fixture가 다르면 schema·fixture를 따른다.
3. schema migration, 공통 type, 패키지 공개 API, 루트 빌드 설정 같은 shared contract는 선행 태스크로 분리한다.
4. 각 태스크에 생성·수정·테스트 Files 목록, 입력·산출 계약, 표적 검증, package별 typecheck, npm test 전체 회귀, 실패 보고 경계를 적는다.
5. 의존성 그래프와 Wave를 작성한다. 파일 소유권이나 shared contract가 겹치면 순차 실행으로 바꾼다. 공유 DB·실제 MCP 서버를 쓰는 작업은 직렬 Wave로 분리한다.
6. 실행 프롬프트가 필요하면 execution-conventions를 읽어 worktree bootstrap, 모델, spawn, 통합, E2E 게이트를 반영한다.
7. 병렬 태스크는 worktree 하나·브랜치 하나·독립 task set 하나에 대응시킨다. 터미널을 나누면 각 터미널에서 그대로 붙여넣을 수 있는 독립 프롬프트를 계획 안에 작성한다.

## 구체성

- schema DDL, 공통 type, package 공개 API signature는 전체 계약을 적는다.
- writer lease·파일 lock·조건부 갱신, 토큰·절감 계산, scan 상태 전이, lazy loading 판별처럼 결론을 바꾸는 로직은 불변식과 주요 테스트 단언을 적는다.
- magic number, 임계값, 집계 window, tokenizer 보정 계수, join 또는 성능 의도가 있는 SQL은 값과 근거를 적는다.
- 순수 type, 단순 getter, 위임 route는 signature와 검증 가능한 사양만 적어도 된다.
- TBD, TODO, 적절히 처리, 위와 유사처럼 작업자에게 설계 판단을 넘기는 표현을 쓰지 않는다.

## 실행 프롬프트 작성

- 프롬프트는 다른 표나 이전 프롬프트를 참조하지 않는 단독 단위로 작성한다.
- 사람은 프로젝트 루트에서 프롬프트 하나만 붙여넣고 별도 git 명령을 실행하지 않는다고 가정한다.
- 프롬프트 바로 앞에 권장 스폰 설정을 한국어로 표시하고, 본문의 native spawn_agent 설정과 일치시킨다.
- 모든 worktree 생성·진입·기점 검증·bootstrap·spawn 지시는 프롬프트 안에 실제 명령과 값으로 넣는다.
- Task/Wave ID, worktree 절대 경로, 허용 Files, 수정 금지 shared contract, 선행 산출물, 테스트, report 절대 경로, 완료 형식을 명시한다.
- 연결 worktree 판별, 계획·참조 문서 존재, 의존성 도구 확인, 실패 시 BLOCKED 조건을 프롬프트에 포함한다.
- background 실행, codex exec 기반 작업 agent, commit·merge·push·하위 agent spawn 금지와 다른 작업자의 변경을 되돌리지 말라는 지시를 자식 message에 포함한다.
- 프롬프트와 사람 대상 설명은 한국어로 작성한다. 코드, 경로, CLI 옵션, 제품 UI 문자열은 원문을 유지한다.

## 자체 검토

- 모든 요구사항이 하나의 태스크 또는 명시된 통합 게이트에 대응하는가?
- shared contract가 선행 태스크로 분리됐고 병렬 task의 쓰기 파일이 겹치지 않는가?
- 테스트가 fixture와 in-memory DB를 사용하며 실환경 E2E가 직렬 Wave로 분리됐는가?
- 판단이 필요한 로직의 계약, fixture, 주요 단언, 실행 가능한 검증 명령을 적었는가?
- DDL·공통 type·공개 API·임계값·SQL을 필요한 수준으로 구체화하고 TBD·TODO를 남기지 않았는가?
- 실행 프롬프트가 필요하면 execution-conventions의 bootstrap·통합·E2E 규칙을 반영했는가?
