# Codex

이 문서를 끝내면 Codex에 MCP Lens 플러그인이 설치되고 훅이 신뢰된 상태가 되어, Codex
세션의 모든 MCP 툴 호출이 로컬에 기록되고 Codex로 쓰는 서버들에 대해 `mcp-lens report`의
`calls` 열이 더 이상 0에 머물지 않는다.

## 쉬운 방법: 확장이 대신 하게 한다

VS Code 확장을 쓰고 있다면 `MCP Lens: Install Hooks for All Clients` 커맨드를 실행한다.
그러면 이 플러그인이 자동으로 설치된다. [VS Code 확장](/ko/guide/vscode-extension) 참고.
이 경로를 탔다면 아래 수동 설치 절은 건너뛰고 [설치 후](#설치-후)로 바로 간다. 이 절은
건너뛰지 않는다. 플러그인이 어떻게 설치됐든 Codex는 훅의 해시를 그 절에서 신뢰하기 전까지
훅을 실행하지 않는다.

## 플러그인을 수동으로 설치한다

Codex 플러그인은 로컬 마켓플레이스 스냅샷에서 등록하며, 이 스냅샷은 저장소 빌드가
만든다. 먼저 저장소를 빌드하고, 그 스냅샷을 `codex` CLI에 등록한다.

```bash
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build                                          # also builds packages/extension/dist/codex-marketplace
codex plugin marketplace add packages/extension/dist/codex-marketplace
codex plugin add mcp-lens@mcplens
```

`codex plugin list --json`을 실행하면 이제 `installed` 아래 `mcp-lens@mcplens`가 보인다.

## 수집하는 것

플러그인은 `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` 훅을 등록하며 번들된 훅
러너만 쓴다. 런타임을 내려받지 않고 MCP Lens 데이터베이스나 네트워크도 열지 않으며, MCP
호출의 최소 메타데이터만 기록해 `~/.mcplens/inbox`에 원자적으로 큐잉한다. 툴 입력, 툴 응답,
프롬프트 텍스트, 어시스턴트 메시지 본문은 보관하지 않고 Codex의 원본 세션 로그도 그대로 둔다.

## 설치 후

Codex는 플러그인에 번들된 훅을, 현재 훅 정의의 해시를 검토하고 신뢰하기 전까지 건너뛴다.
Codex 안에서 `/hooks`를 열어 MCP Lens 훅 정의를 검토하고 현재 해시를 신뢰한다. 해시가
바뀔 때마다 이 과정을 다시 한다. 훅 상태가 바뀐 뒤에는 새 Codex 세션을 시작한다.

수집을 멈추려면 플러그인 등록을 비활성화하거나 제거한다. 제거하면 플러그인이 삭제된다.
