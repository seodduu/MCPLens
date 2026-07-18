---
description: MCP 툴 컨텍스트 낭비 감사 — 비용×사용 매트릭스와 권고를 분석해 조치를 제안
allowed-tools: Bash(npx mcp-lens *)
---

다음 명령을 실행해 MCP Lens의 감사 리포트를 얻어라:

!`npx mcp-lens report --days 30 --format ai`

위 리포트를 바탕으로:
1. 제거 권장(remove) 툴들을 표로 요약하고 예상 절약 토큰을 밝혀라
2. filter-server 권고가 있으면 해당 클라이언트 설정에서 툴을 필터링하는 구체적 방법을 제안하라
3. 근거 라벨(실측/하한 추정/전량 가정)을 함께 표기해 숫자의 신뢰 수준을 명시하라
사용자가 동의하면 설정 수정을 도와라 (수정 전 반드시 백업).
