# Gemini CLI

이 문서를 끝내면 Gemini CLI에 MCP Lens 확장이 설치되어, Gemini CLI 세션의 모든 MCP 툴
호출이 로컬에 기록되고 Gemini CLI로 쓰는 서버들에 대해 `mcp-lens report`의 `calls` 열이
더 이상 0에 머물지 않는다.

## 쉬운 방법: VS Code 확장이 대신 하게 한다

VS Code 확장을 쓰고 있다면 `MCP Lens: Install Hooks for All Clients` 커맨드를 실행한다.
그러면 이 확장이 자동으로 설치된다. [VS Code Extension](/ko/guide/vscode-extension) 참고.
이 경로를 탔다면 아래 수동 설치 절은 건너뛰고 [설치 후](#설치-후)로 바로 간다. 확장이 어떤
경로로 설치됐든 이 절은 그대로 적용된다.

## 확장을 수동으로 설치한다

```sh
gemini extensions install /absolute/path/to/packages/gemini-extension
```

`/absolute/path/to` 자리에 자기 리포지터리 클론의 절대경로를 넣는다. 확장의 매니페스트
이름은 `mcp-lens`이므로, 설치 후 `gemini extensions list`를 실행하면 설치된 확장 목록에
`mcp-lens`가 보인다. 이후 Gemini CLI를 재시작해 확장과 훅 등록을 불러오게 한다.

## 수집하는 것

확장은 Gemini CLI 훅 이벤트에서 로컬 전용 MCP 회계 메타데이터만 수집하고, `tool_input`,
`tool_response`, `llmContent`, `returnDisplay`를 포함한 민감한 페이로드 필드는 버린다.
번들된 훅 러너만 쓰며 런타임을 내려받지 않고 MCP Lens 데이터베이스나 네트워크도 절대
열지 않는다. 이벤트는 `~/.mcplens/inbox`에 원자적으로 큐잉되고, Gemini의 원본 로그는
수정되거나 이동되지 않는다.

## 설치 후

Gemini CLI를 재시작해 확장과 훅을 불러온다.

확장을 지우지 않고 수집만 멈추려면 비활성화하고 다시 재시작한다.

```sh
gemini extensions disable mcp-lens
```

이 명령은 확장을 삭제하지 않고 새 캡처만 멈춘다. 확장 상태를 바꾼 뒤에는 Gemini CLI를
재시작해야 변경이 적용된다.

완전히 제거하려면 Gemini CLI의 확장 제거 커맨드로 삭제하고 재시작한다. 어느 쪽이든 이미
큐에 쌓인 메타데이터나 원본 Gemini 로그에는 손대지 않는다.
