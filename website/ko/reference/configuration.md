# 설정

이 문서는 MCP Lens가 데이터를 어디에 저장하는지와 VS Code 확장 설정 전체를 정리한다.
walkthrough를 다시 뒤지지 않고도 키나 경로를 바로 찾을 수 있다. 무엇을 왜 바꿔야 하는지는
[VS Code 확장](/ko/guide/vscode-extension)과 [전역 조치](/ko/guide/global-actions)를
본다.

## 데이터 위치

MCP Lens가 보관하는 모든 것은 `~/.mcplens` 아래에 있다. 프로젝트 안이나 클라이언트 자체의
설정·로그에는 절대 쓰지 않는다.

| 경로 | 내용 |
| --- | --- |
| `~/.mcplens/lens.db` | SQLite 데이터베이스. 스캔된 툴 정의, 훅으로 관측한 호출, 세션을 담는다. |
| `~/.mcplens/inbox` | 확장이나 CLI가 데이터베이스로 옮기기 전에 대기하는 훅 이벤트 큐. |
| `~/.mcplens/db-writer.lock` | 확장과 CLI가 동시에 쓰지 않도록 막는 writer lease 파일. |
| `~/.mcplens/oauth` | 인증된 MCP 서버의 OAuth 토큰과 클라이언트 등록 정보. 소유자만 읽을 수 있는 파일 권한으로 기록된다. |

## 확장 설정

VS Code Settings UI에서 `MCP Lens`를 검색해 열거나, `settings.json`을 직접 편집한다.

| 설정 | 타입 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `mcpLens.reportDays` | number | `30` | 상태 표시줄 요약과 리포트가 집계하는 기간(일). |
| `mcpLens.reportDetail` | `summary` \| `full` | `summary` | **MCP Lens: Show Report** 커맨드의 상세 수준. `summary`는 후보·정상 툴 목록을 5개로 제한한다. 조치나 점검이 필요한 항목은 어느 값이든 항상 전체가 표시된다. |
| `mcpLens.autoScan` | `prompt` \| `always` \| `never` | `never` | 새 서버가 감지됐을 때 자동 스캔 여부. `prompt`는 먼저 물어보고, `always`는 (walkthrough에서 첫 수동 스캔을 한 뒤) 바로 스캔하며, `never`는 직접 트리거할 때만 스캔한다. |
| `mcpLens.authIgnore` | string[] | `[]` | 로그인 요청을 더 이상 표시하지 않을 서버 이름 목록. "Don't ask for this server" 버튼으로 자동 채워진다. |
| `mcpLens.oauthClients` | object | `{}` | 자동 클라이언트 등록을 거부하는 서버용 OAuth 클라이언트 id. 예: `{ "github": "Iv1.abc123" }`. 클라이언트 시크릿은 여기 저장되지 않고 `~/.mcplens/oauth/clients.json`에 들어간다. |
| `mcpLens.unsupportedServers` | string[] | `[]` | Lens가 지원할 수 없다고 판단한 서버 이름(예: 자동 클라이언트 등록을 거부하는 서버). 자동으로 채워지며, 트리에서 숨겨지고 다시 묻지 않는다. |
| `mcpLens.inferenceProvider` | `auto` \| `claude` \| `codex` | `auto` | 의존성 분석에 쓰는 제공자. `auto`는 두 CLI가 모두 설치되어 있으면 Claude를 고른다. 하나를 명시적으로 고정하려면 이 값을 설정한다. |
| `mcpLens.autoAnalyze` | boolean | `false` | 자동 스캔 뒤 새 툴을 제공자 CLI로 분석해서 각각 독립적으로 꺼도 되는지 판단한다. 이는 제공자의 토큰을 소모하며 툴 정의와 사용량 카운트를 그쪽으로 보낸다. walkthrough에서 한 번 동의하기 전에는 절대 실행되지 않는다. |
| `mcpLens.claudeModel` | string | `haiku` | 의존성 분석에 쓰는 Claude 모델. |
| `mcpLens.codexModel` | string | `gpt-5.6-luna` | 의존성 분석에 쓰는 Codex 모델. |
| `mcplens.dependencyAnalysis.rollout` | `off` \| `claude` \| `codex` \| `all` | `off` | 전역 조치(사용하지 않는 툴을 해당 클라이언트의 설정 파일을 편집해 끄는 것)를 어느 클라이언트가 쓸 수 있는지. 분석·캐시·상세 보기는 `off`를 포함한 모든 값에서 계속 쓸 수 있다. Gemini CLI는 여기서 절대 허용되지 않는다. 전역 조치가 이를 지원하지 않는다. |

::: tip 참고
`mcplens.dependencyAnalysis.rollout`은 이 문서의 다른 모든 키와 다른(소문자) 설정 네임스페이스를
쓴다. 오타가 아니라 VS Code가 실제로 읽는 정확한 키다. `settings.json`에 직접 설정한다면
대소문자를 다시 한번 확인한다.
:::
