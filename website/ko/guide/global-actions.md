# 전역 조치

이 문서를 끝내면 Claude Code와 Codex 중 하나 또는 둘 다에서 전역 조치의 잠금을 풀고,
[리포트 읽기](/ko/guide/reading-reports)의 `remove`나 `filter-server` 권장을 설정 파일을 직접
고치지 않고 끌 수 있으며, 마음이 바뀌면 되돌릴 수 있는 상태가 된다.

전역 조치는 전적으로 [VS Code 확장](/ko/guide/vscode-extension) 안에서 산다. 이 문서의
모든 단계는 VS Code 커맨드이고, CLI에는 대응하는 기능이 없다. CLI만 쓰는 경로에서는 리포트의
한 행에 직접 클라이언트 설정을 고쳐서 대응해야 한다.
[툴을 전역으로 끄기](#툴을-전역으로-끄기) 아래 두 블록은 확장이 써 넣었을 규칙 그대로를
보여준다.

## 전역 조치란

전역 조치는 클라이언트 설정을 고쳐서 현재 세션뿐 아니라 모든 세션에서 그 툴을 쓸 수 없게
만든다. 리포트가 어떤 툴을 꺼도 안전하다고 알려준 다음 단계다.

| 클라이언트 | 전역 조치 |
|---|---|
| Claude Code | 지원 |
| Codex | 지원 |
| Gemini CLI | 미지원 |

Gemini CLI는 아예 제외된다. 아래 rollout 설정과 무관하게 대상으로 제시되지 않는다.

## 전역 조치는 기본적으로 잠겨 있다

`mcplens.dependencyAnalysis.rollout` 설정이 이를 제어하며 기본값은 `"off"`다. 꺼진 상태에서
MCP Lens는 여느 때처럼 권장을 계산하고 리포트와 사이드바에 보여주지만, 클라이언트 설정
파일은 절대 고치지 않는다.

| 값 | 효과 |
|---|---|
| `off` (기본값) | 전역 조치가 잠긴다. Lens는 클라이언트 설정을 고치지 않는다. |
| `claude` | Claude Code에 대해서만 전역 조치를 허용한다. |
| `codex` | Codex에 대해서만 전역 조치를 허용한다. |
| `all` | Claude Code와 Codex 모두에 대해 전역 조치를 허용한다. |

## 켜기

Command Palette(`Cmd/Ctrl+Shift+P`)에서 **MCP Lens: Open Global Actions Setting** 커맨드를
실행하면 Settings의 `mcplens.dependencyAnalysis.rollout`으로 바로 이동한다. 거기서 `claude`,
`codex`, `all` 중 하나를 고른다.

또는 `settings.json`에 직접 설정해도 된다.

```json
{
  "mcplens.dependencyAnalysis.rollout": "all"
}
```

## 의존성 분석을 먼저 돌린다

**MCP Lens: Disable Globally**는 의존성 분석이 아직 판정하지 않은 툴에 대해서는 거부한다.
무언가를 고치기 직전에 그 툴에 대한 저장된 분석 결과를 다시 읽고, 결과가 없으면 "Review
required"로 취급하는데 이는 대상 자격이 없다. 그러니 무언가를 끄기 전에 **MCP Lens: Analyze
Dependencies**를 실행한다(또는 온보딩 walkthrough의 3단계가 대신 하게 둔다).

## 툴을 전역으로 끄기

rollout을 설정하고 분석까지 마쳤다면, MCP Lens 사이드바 트리를 열어 끄고 싶은 툴을 선택하고
**MCP Lens: Disable Globally**를 실행한다. 정확히 어느 파일을 고치는지는 그 툴이 속한
클라이언트에 따라 다르다.

::: code-group

```jsonc [~/.claude/settings.json]
{
  "permissions": {
    "deny": [
      "mcp__web-search__web-search_place_search"
    ]
  }
}
```

```toml [~/.codex/config.toml]
[mcp_servers.web-search]
disabled_tools = ["web-search_place_search"]
```

:::

이 규칙을 직접 쓸 필요는 없다. MCP Lens가 고른 툴 하나에 대한 규칙 하나만 추가하고, 파일을
먼저 백업하고, 나중에 정확히 그 규칙만 제거할 수 있도록 변경 사항을 기록한다.

## 툴이 대상에서 제외되는 이유

**MCP Lens: Disable Globally**는 rollout이 켜져 있어도 거부할 수 있다. 가장 흔한 이유는
의존성 분석이 아직 그 툴을 `Independent`로 표시하지 않았거나, 같은 서버 이름이 설정
출처마다 다른 명령/URL로 풀리는 경우다(이런 정체성 충돌은 Lens가 임의로 추측하지 않는다).
**MCP Lens: Analyze Dependencies**를 다시 실행하거나 이름 충돌을 해소한 다음 다시
시도한다.

## 툴 되돌리기

꺼둔 툴에서 **MCP Lens: Restore Globally**를 실행하면 Lens가 추가했던 규칙을 제거한다.
그사이 그 설정 파일을 직접 고쳐서 Lens가 기록한 내용과 더는 맞지 않는다면, 되돌리기는
그 편집을 조용히 덮어쓰지 않고 충돌로 거부된다.

## 알아둘 점

- **Claude Code의 `bypassPermissions` 모드**는 권한 규칙 계층을 통째로 건너뛸 수 있다.
  그래서 그 모드에서는 전역 차단이 절대적인 보장이 아니다.
- **Codex**는 `disabled_tools`를 `enabled_tools` 다음에 적용한다. 사용자 설정보다 우선하는
  조직 관리 정책이 있으면 Lens의 규칙이 적용되지 않을 수 있는데, 그런 경우 Lens는 쓰기가
  성공한 척하지 않고 그 클라이언트를 policy-restricted로 보고한다.
