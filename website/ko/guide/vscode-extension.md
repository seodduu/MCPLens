# VS Code Extension

이 문서를 끝내면 확장이 설치되고 온보딩을 마친 상태가 되며, activity bar의 MCP Lens 아이콘에서
자기 자신의 비용 × 사용량 매트릭스를 직접 보게 된다. 이 확장이 MCP Lens의 주된 배포 경로다.
스캔, 훅 설치, 리포트, 의존성 분석이 모두 확장 안에서 이뤄지므로 별도의 CLI 설치가 필요 없다.

## Requirements

- Node.js 20 이상.
- VS Code 1.90 이상.

## Install

확장은 아직 VS Code Marketplace에 게시되지 않았다. `.vsix`를 직접 빌드해서 로컬에 설치한다.

```bash
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm run package -w mcp-context-lens     # creates packages/extension/*.vsix
code --install-extension packages/extension/mcp-context-lens-<version>.vsix
```

`<version>`은 `npm run package`가 `.vsix` 파일 이름에 찍어 준 버전으로 바꿔 넣는다.
`code --install-extension`은 확장이 설치되었음을 확인하는 줄을 출력한다.

## Run the onboarding walkthrough

VS Code를 다시 연다. activity bar에 MCP Lens 아이콘이 나타나고, 온보딩 walkthrough가
자동으로 열린다. 단계는 순서대로 4개다.

1. **Scan**: 클라이언트에 설정된 MCP 서버를 스캔해서 각 툴 정의가 소모하는 토큰 수를 잰다.
2. **Install hooks**: 사용하는 클라이언트에 훅을 설치한다. 그러면 리포트의 0이 실제 호출
   수로 채워지기 시작한다.
3. **Dependency analysis**: 실제로 연결된 서버를 기준으로 어떤 툴을 필터링하거나 제거해도
   안전한지 LLM에게 판단시킨다 (이 단계가 실행되기 전에 아래의 동의 선택을 먼저 본다).
4. **Enable global actions**: 명시적으로 허용하면 확장이 클라이언트 설정 파일을 편집해
   툴을 끌 수 있게 된다.

온보딩이 끝나면 activity bar 아이콘 아래에 `Cost × Usage Matrix`와 `Setup Status` 두 뷰가
생긴다.

## Choose how much runs automatically

마지막 온보딩 단계는 질문 하나를 던진다. 새로 연결된 MCP 서버를 앞으로 확장이 알아서
처리할지 묻는 것이다. 선택지는 세 가지다.

- 스캔과 의존성 분석을 모두 맡긴다.
- 스캔만 맡기고 분석은 직접 실행한다 (분석은 LLM 토큰을 쓰므로, 의도적으로 트리거하고
  싶은 사람도 있다).
- 둘 다 직접 한다.

이 질문에 답하기 전에는 아무것도 자동으로 실행되지 않는다. 자동 처리를 켜면 이후 새로
연결하는 서버만 자동으로 처리되며, 이미 기록된 동의를 재사용할 뿐 다시 묻지 않는다.
동의는 `MCP Lens: Withdraw Inference Consent` 커맨드로 언제든 철회할 수 있고, 이 커맨드는
자동 분석도 함께 멈춘다. 자동 스캔과 자동 분석은 `mcpLens.autoScan`,
`mcpLens.autoAnalyze` 설정으로 각각 따로 끌 수 있다.

## What stays local

모든 데이터는 자기 기기의 `~/.mcplens/lens.db` (SQLite)에 저장된다. MCP Lens는 세션·턴·호출
ID, 클라이언트 이름, 서버·툴 이름, 관찰 시각, 호출 소요 시간, 호출 에러 여부, 그리고 스캔한
툴 정의의 토큰 수를 수집한다. 대화 본문, 프롬프트, 툴 입력, 툴 응답, 어시스턴트 응답 본문,
소스 코드는 절대 수집하지 않는다. 기기 밖으로 나가는 기능은 의존성 분석 하나뿐이며, 이 기능은
walkthrough 3단계에서 고른 LLM 제공자에게 툴 정의와 집계된 사용량 수치만 보낸다.

원본 클라이언트 로그는 항상 읽기 전용이다. MCP Lens는 이를 절대 수정하거나 옮기지 않는다.

## Next steps

`calls` 컬럼을 0에서 실제 수치로 바꾸려면 [Claude Code](/ko/guide/claude-code),
[Codex](/ko/guide/codex), [Gemini CLI](/ko/guide/gemini-cli)에 훅을 설치하거나, 확장 안에서
`MCP Lens: Install Hooks for All Clients` 커맨드로 한 번에 전부 설치한다. 매트릭스의 모든
컬럼과 권장 조치를 이해하려면 [Reading Reports](/ko/guide/reading-reports)를 본다. 스캔이
내부에서 어떻게 동작하는지는 [How It Works](/ko/concepts/how-it-works)를 본다.
