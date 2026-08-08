# Claude Code

이 문서를 끝내면 Claude Code에 MCP Lens 플러그인이 설치되어 세션 안의 모든 MCP 툴 호출이
로컬에 기록되고, `mcp-lens report`의 `calls` 열이 더 이상 0에 머물지 않는 상태가 된다.
동시에 `/lens-audit` 슬래시 명령도 쓸 수 있게 되는데, 이 명령은 최신 리포트를 대화창으로
바로 가져온다.

## 쉬운 방법: 확장이 대신 하게 한다

VS Code 확장을 쓰고 있다면 `MCP Lens: Install Hooks for All Clients` 커맨드를 실행한다.
그러면 이 플러그인이 자동으로 설치된다. [VS Code 확장](/ko/guide/vscode-extension) 참고.
이 경로를 탔다면 아래 수동 설치 절은 건너뛰고 [설치 후](#설치-후)로 바로 간다. 플러그인이
어떤 경로로 설치됐든 이 절은 그대로 적용된다.

## 플러그인을 수동으로 설치한다

```bash
claude plugin add /path/to/MCPLens-V2/packages/lens-audit-plugin
```

`/path/to/MCPLens-V2` 자리에 자기 저장소 클론 경로를 넣는다. 이 명령은 플러그인의 훅을
등록하고 `/lens-audit` 슬래시 명령을 추가한다. 마켓플레이스 등록 없이 로컬에서만 테스트하려면
`--plugin-dir`로 대신 불러올 수 있다.

## 수집하는 것

플러그인은 번들된 훅 러너만 쓴다. 런타임을 따로 내려받지 않고 네트워크나 MCP Lens
데이터베이스도 열지 않는다. MCP 호출마다 클라이언트, 세션, 서버, 툴 이름, 타임스탬프라는
최소 정보만 기록해 `~/.mcplens/inbox`에 원자적으로 쓴다. 툴 입력, 툴 응답, 프롬프트, 응답
본문은 절대 저장하지 않으며 Claude의 원본 트랜스크립트나 로그에는 손대지 않는다.

## 설치 후

Claude Code 플러그인을 리로드하고 새 세션을 시작해야 훅 정의가 적용된다. 새 세션에서
`/lens-audit`를 실행하면 최신 비용 × 사용량 리포트가 대화창으로 들어온다. 뒤에서는
`npx --no-install mcp-lens report --days 30 --format ai`가 실행되므로, 슬래시 명령이
동작하려면 `mcp-lens` CLI가 따로 설치되어 있어야 한다 ([CLI 레퍼런스](/ko/reference/cli) 참고).

수집을 멈추려면 플러그인을 비활성화하거나 삭제하고 새 세션을 시작한다.
