# 빠른 시작

이 문서를 끝내면 MCP Lens가 설치되고 자기 비용 × 사용량 매트릭스, 즉 각 MCP 툴 정의가
몇 토큰을 쓰는지와 실제로 몇 번 호출되었는지를 나란히 놓은 표를 직접 본 상태가 된다.

## 요구 사항

- Node.js 20 이상.
- VS Code 확장을 쓴다면 VS Code 1.90 이상.

## 설치

경로를 하나 고른다. VS Code 확장이 주 배포판이다. 스캔, 훅 설치, 리포트, 의존성 분석이
전부 그 안에 있어서 별도로 CLI를 설치할 필요가 없다. CLI는 선택 사항이며 스크립팅이나
터미널만 쓰는 워크플로에 유용하다. 확장 경로의 마지막 줄은 방금 `npm run package`가 빌드한
`.vsix`를 설치한다. `<version>`은 그 단계의 출력에 찍힌 버전으로 바꾼다
(`packages/extension/` 아래 생긴 파일 이름과 일치한다).

::: code-group

```bash [VS Code 확장 (권장)]
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm run package -w mcp-context-lens     # creates packages/extension/*.vsix
code --install-extension packages/extension/mcp-context-lens-<version>.vsix
```

```bash [CLI]
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm link -w @mcp-lens/cli      # only if you want mcp-lens outside the repository
```

:::

::: warning 주의
레지스트리에는 `mcp-lens`라는 이름의 무관한 패키지가 이미 존재한다. 로컬에 bin이 없는
상태에서 그냥 `npx mcp-lens`를 실행하면 그 서드파티 패키지를 내려받아 실행한다.
항상 `npx --no-install mcp-lens` 형태를 쓰거나, 위처럼 링크된 bin을 직접 호출한다.
:::

## 확인

::: code-group

```md [VS Code 확장]
VS Code를 다시 연다. activity bar에 MCP Lens 아이콘이 나타나고, 온보딩 walkthrough가
자동으로 열린다.
```

```bash [CLI]
npx --no-install mcp-lens --help
```

:::

CLI 명령은 다음을 포함한 여러 줄을 출력한다.

```
mcp-lens: MCP context accounting tool
```

## 5분 만에 하는 첫 감사

두 경로 모두 같은 매트릭스에 도달한다. 아래 CLI 명령은 앞의 경고대로 `npx --no-install mcp-lens`
형태를 쓰며 클론한 저장소 안에서 실행한다. 선택 사항인 `npm link` 단계를 실행했다면
어디서든 그냥 `mcp-lens`가 동작하므로 이 문서 전체에서 `npx --no-install` 접두사를 빼도 된다.

### 1. MCP 서버 스캔

::: code-group

```md [VS Code 확장]
Command Palette(`Cmd/Ctrl+Shift+P`)에서 **MCP Lens: Scan MCP Servers**를 실행한다. 온보딩
walkthrough의 첫 단계가 같은 스캔을 실행하므로, walkthrough를 막 끝냈다면 이미 완료된
상태다.
```

```bash [CLI]
npx --no-install mcp-lens scan
```

:::

스캔은 설정된 각 stdio 서버를 잠깐 기동해 `tools/list`를 호출한다. LLM 토큰을 전혀 쓰지 않고
클라이언트 설정 파일을 건드리지도 않으므로, 운영 중인 설정에 대해서도 안전하게 돌릴 수 있다.

### 2. 비용 × 사용량 매트릭스 읽기

::: code-group

```md [VS Code 확장]
activity bar에서 MCP Lens 아이콘을 열고 `Cost × Usage Matrix` 뷰를 본다. 같은 매트릭스를
전체 리포트 페이지로 보려면 Command Palette에서 **MCP Lens: Show Report**를 실행한다.
```

```bash [CLI]
npx --no-install mcp-lens report
```

:::

리포트는 각 툴의 정의 토큰 비용을 실제 호출 횟수 옆에 놓고, 행마다 권장 조치를 붙인다.
아래는 CLI가 출력하는 표 형태다. 실제 실행에서 나온 행이며, `loaded/sessions`, `errorRate`,
`errorTokens` 열은 폭 때문에 여기서는 잘라냈고 긴 `reason` 셀은 말줄임표로 줄였다.
실제 터미널에서는 모든 열과 각 reason 문장 전체가 나온다.

```
server          tool                                defTokens  calls  respTokens  action         confidence  reason
--------------  ----------------------------------  ---------  -----  ----------  -------------  ----------  ---------------------------------------------------
web-search      web-search_place_search             17251      0      0           remove         medium      definition 17,251 tokens, 0 calls...
knowledge-base  knowledge-base-query-meeting-notes  5929       0      0           filter-server  high        Only 2 of 28 tools used on server knowledge-base...
weather-tools   get_weather                         74         4      83          keep           high        called 4 times

savings: potential=61893 actual=26839 saved=35054
```

마지막 줄이 핵심 숫자다. 리포트가 지금 제거 가능하다고 본 것을 전부 끄면, `saved` 토큰만큼이
매 프롬프트마다 더 이상 따라붙지 않는다.

## 다음 단계

이제 매트릭스를 봤다. `calls`가 모든 항목에서 0으로 머물지 않고 실제 사용량을 반영하게
하려면 다음으로 자기 클라이언트에 훅을 설치한다. [Claude Code](/ko/guide/claude-code),
[Codex](/ko/guide/codex), [Gemini CLI](/ko/guide/gemini-cli) 중 하나를 본다. 열과 조치가
정확히 무엇을 뜻하는지는 [리포트 읽기](/ko/guide/reading-reports)를 본다. 스캔과 훅이
내부에서 어떻게 맞물리는지는 [동작 원리](/ko/concepts/how-it-works)를 본다.
