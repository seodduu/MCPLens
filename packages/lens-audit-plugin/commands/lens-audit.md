---
description: "MCP 툴 컨텍스트 낭비 감사: 비용×사용 매트릭스와 권고를 분석해 조치를 제안"
allowed-tools: Bash(npx --no-install mcp-lens:*)
---

다음 명령을 실행해 MCP Lens의 감사 리포트를 얻어라:

!`npx --no-install mcp-lens report --days 30 --format ai`

`--no-install`은 의도적이다. 이 커맨드는 **로컬에 설치된 mcp-lens CLI만** 실행하며
npm 레지스트리에서 무언가를 자동으로 내려받지 않는다. 레지스트리에는 이 프로젝트와
무관한 동명 패키지가 존재하기 때문이다.

명령이 `could not determine executable to run` 또는 `npx canceled due to missing
package`류의 메시지로 실패하면 CLI가 설치돼 있지 않은 것이다. 이때는 리포트를 지어내지
말고 아래 설치 안내를 사용자에게 그대로 전달한 뒤 멈춰라.

- MCPLens 저장소를 클론한 경우: 저장소 루트에서 `npm install && npm run build`를 실행한다.
  그 뒤 저장소 루트(또는 그 하위 디렉터리)에서 이 커맨드를 실행하면
  `node_modules/.bin/mcp-lens`가 잡힌다.
- 저장소 밖에서 쓰려면 `npm link -w @mcp-lens/cli`로 전역에 bin을 연결한다.
- 대부분의 사용자에게는 VS Code 확장(MCP Context Lens)이 더 쉬운 경로다. 확장은 같은
  데이터를 사이드바에서 보여주며 CLI 설치가 필요 없다.

리포트를 얻었다면 그것을 바탕으로:

1. 제거 권장(remove) 툴들을 표로 요약하고 예상 절약 토큰을 밝혀라
2. filter-server 권고가 있으면 해당 클라이언트 설정에서 툴을 필터링하는 구체적 방법을 제안하라
3. 근거 라벨(실측/하한 추정/전량 가정)을 함께 표기해 숫자의 신뢰 수준을 명시하라

리포트의 정의 토큰(defTokens)이 모두 '-'로 비어 있으면 아직 MCP 서버 정의가 스캔되지 않은 것이다.
이 경우 먼저 `npx --no-install mcp-lens scan`을 실행해 tool_definitions를 채우도록 사용자에게 안내하라.

사용자가 동의하면 설정 수정을 도와라 (수정 전 반드시 백업).
