# MCP Lens

AI 코딩 클라이언트(Claude Code·Codex·Gemini CLI)의 MCP 컨텍스트 회계 도구.

- 설계: `MCP-Lens-설계문서-v2.md`
- 구현 계획: `docs/plans/2026-07-19-mcp-lens-mvp-구현계획.md` — 태스크·터미널 운용의 유일한 진실

## 실행 모델

터미널 1개 = 독립 태스크 세트 1개 = worktree 1개 = 브랜치 1개.
각 터미널의 Codex 세션은 오케스트레이터이며, 태스크마다 Codex 네이티브 서브에이전트를
스폰해 실행하고 태스크 사이마다 테스트 통과와 파일 소유권 준수를 리뷰한다.

독립적이고 파일 소유권이 겹치지 않는 태스크는 병렬 서브에이전트로 실행한다.
선행 태스크에 의존하거나 같은 파일을 수정하는 태스크는 반드시 순차 실행한다.

## 모델 배분

Claude의 역할 구분은 Codex의 GPT-5.6 계열에 다음과 같이 대응한다.

| 역할 | Codex 모델 | reasoning effort |
|---|---|---|
| 오케스트레이터 세션(리뷰·머지 게이트) | `gpt-5.6-sol` | `high` |
| 태스크 실행 서브에이전트 — 기본(테스트+구현 모두) | `gpt-5.6-terra` | `medium` |
| 예외: 어댑터 태스크(Task 2·3·4)와 Wave 4 E2E(Task 14) 서브에이전트 | `gpt-5.6-sol` | `high` |

서브에이전트를 스폰할 때 위 모델과 reasoning effort를 명시하거나, 같은 설정으로 구성된
프로젝트/사용자 커스텀 에이전트를 선택한다. 현재 Codex 표면이 자식별 모델 지정을 지원하지
않으면 부모 설정을 상속하되, 태스크 프롬프트에 필요한 역할과 추론 수준을 명확히 적는다.

`gpt-5.6-sol` 예외의 근거: 어댑터는 계획서의 필드명 후보와 실제 픽스처의 불일치를
판단해야 하고, E2E는 실기기 디버깅이 필요하다. 나머지 태스크는 계획서에 코드와 사양이
명확하므로 `gpt-5.6-terra`를 사용한다.

## 모든 세션·서브에이전트 공통 규칙

- 자기 태스크의 `Files` 목록 밖 파일은 수정하지 않는다. 특히
  `packages/core/src/types.ts`, `packages/core/src/store/schema.sql`, 루트 설정은 공유 계약이다.
  계약이 맞지 않으면 직접 수정하지 말고 오케스트레이터에게 보고한다.
- 계획서의 필드명과 픽스처가 다르면 **픽스처가 진실**이다. 코드를 픽스처에 맞춘다.
- core에서 `vscode`를 import하지 않는다.
- DB 경로는 `~/.mcplens/lens.db`이며, 코드에서는 `os.homedir()`와 `path.join()`으로 조립한다.
  `~` 문자열을 하드코딩하지 않는다.
- 네이티브 애드온을 추가하지 않는다.
- 원본 클라이언트 로그는 읽기 전용이다. 수정하거나 이동하지 않는다.
- 파싱 실패는 throw하지 않고 건너뛰며 `parseErrors`를 증가시킨다.
- 유닛 테스트는 픽스처와 `:memory:` DB만 사용해 터미널 병렬 안전성을 유지한다.
- 공유 DB나 실제 MCP 서버를 사용하는 스모크/E2E는 Wave 4에서 직렬 실행한다.
- 구현은 계획서의 태스크 순서, 파일 소유권, 테스트 절차를 따른다.
- 완료를 주장하기 전에 해당 태스크의 테스트를 실행하고 결과를 확인한다.

## 역할 고정 에이전트 실행 계약

이 절은 위 모델 배분의 일반적인 "부모 설정 상속" fallback보다 우선한다.
역할별 모델 또는 reasoning effort가 지정된 작업은 단순 프롬프트나 `task_name`만으로
커스텀 에이전트가 선택됐다고 간주하지 않는다.

### Native spawn 금지 조건

- 현재 `spawn_agent` 인터페이스에 `agent_type`, `model`, `model_reasoning_effort` 중 필요한
  선택자가 노출되지 않으면 역할 고정 작업에 native `spawn_agent`를 사용하지 않는다.
- `task_name`은 표시·추적용 라벨일 뿐 `.codex/agents/<name>.toml`을 선택하는 역할
  식별자가 아니다.
- 프롬프트에 `mcplens-spec-reviewer를 spawn해라`라고 쓰는 것만으로 모델·effort가
  적용됐다고 간주하지 않는다.
- `agent_role: null`, 예상과 다른 effort, 커스텀 nickname 후보 불일치는 일반 자식이
  부모 설정을 상속한 증거로 취급한다.
- 역할 선택이 실패했을 때 native 일반 자식으로 조용히 fallback하지 않는다.

Native spawn은 현재 도구 스키마가 필요한 역할 선택자를 실제로 제공하고, 생성된 자식의
세션 메타데이터에서 agent role·model·effort를 검증할 수 있을 때만 역할 고정 작업에 사용할
수 있다. 모델 고정이 필요 없는 병렬 탐색·검색 작업에는 일반 native subagent를 사용할 수 있다.

### 필수 프로세스 실행 방식

역할별 모델·effort가 필요한 구현, 리뷰, 검증은 별도의 `codex exec` 프로세스로 실행한다.
부모 터미널은 프로세스를 시작하고 종료를 기다린 뒤 결과와 diff를 직접 검증한다.

기본 구현 작업:

```bash
codex exec \
  -C <worktree> \
  -m gpt-5.6-terra \
  -c 'model_reasoning_effort="medium"' \
  -s workspace-write \
  --ephemeral \
  "<implementer task brief>"
```

어댑터·고난도 구현 작업:

```bash
codex exec \
  -C <worktree> \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="high"' \
  -s workspace-write \
  --ephemeral \
  "<adapter implementer task brief>"
```

Spec reviewer, quality reviewer, verifier:

```bash
codex exec \
  -C <worktree> \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="high"' \
  -s read-only \
  --ephemeral \
  "<review or verification task brief>"
```

실행 역할에 맞춰 자식 프롬프트는 먼저 다음 파일 중 하나를 읽고 그
`developer_instructions`를 준수하도록 명시한다.

- `.codex/agents/mcplens-implementer.toml`
- `.codex/agents/mcplens-adapter-implementer.toml`
- `.codex/agents/mcplens-spec-reviewer.toml`
- `.codex/agents/mcplens-quality-reviewer.toml`
- `.codex/agents/mcplens-verifier.toml`

### 무컨텍스트 실행 프롬프트 필수 항목

터미널별 실행 프롬프트를 작성할 때는 이전 대화가 전혀 없는 새 `codex exec` 프로세스를
전제로 한다. 각 프로세스 프롬프트에 다음을 모두 포함한다.

- 역할과 읽어야 할 `.codex/agents/*.toml` 경로
- 저장소와 worktree의 절대 경로
- task ID와 계획서의 절대 경로
- base commit과 대상 branch
- 수정 허용 `Files` 목록과 수정 금지 공유 파일
- 구현 요구사항 또는 리뷰 기준
- 정확한 테스트·빌드·정적 검사 명령
- 커밋·merge·push·하위 agent spawn 금지 여부
- 결과 보고 형식과 report 파일 경로

긴 프롬프트는 shell quoting에 의존해 한 인자로 조립하지 말고, 안전한 prompt 파일이나
stdin으로 전달한다. 비밀 값이나 신뢰할 수 없는 외부 문자열을 명령행에 보간하지 않는다.

### 오케스트레이터 검증 의무

- 부모는 `codex exec` 명령에 지정한 model·effort·sandbox를 실행 기록에 남긴다.
- 자식의 완료 보고만 신뢰하지 않고 diff, 파일 소유권, 테스트, 빌드를 직접 확인한다.
- reviewer가 수정하지 않았는지, implementer가 허용 파일 밖을 수정하지 않았는지 확인한다.
- 프로세스 실패나 모델 선택 실패 시 동일 역할의 일반 native subagent로 대체하지 않는다.
- 필요한 역할 프로세스를 실행할 수 없으면 `BLOCKED`로 보고한다.
- 모든 reviewer 승인과 verifier PASS 이후에만 부모가 commit 또는 merge한다.
