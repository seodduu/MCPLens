# Wave 4 실기기 스모크 기록 (2026-07-19)

계획서 Task 14 Step 2의 실기기 검증 결과. 자동화 항목은 메인 터미널이 직렬 수행,
수동 항목 3건은 하단에 절차와 함께 남김.

## 완료 항목

| # | 항목 | 결과 | 측정치 |
|---|---|---|---|
| 1 | CLI 실백필 (`mcp-lens report`) | ✅ | **실세션 130개 백필 0.8초** (목표 <30s). 매트릭스 11행, 신뢰도 열 실데이터로 채워짐 |
| 2 | 스캐너 실서버 기동 | ✅ | 최소 stdio 서버(툴 2개) 대상 initialize→tools/list→토큰 계산 (echo 51tok, add 59tok). 실설정(~/.claude.json)은 http 서버(vercel)뿐이라 `scan`이 스킵 안내 출력 — 정상 동작 |
| 3 | 대시보드 헤드리스 | ✅ | `npm start -w @mcp-lens/dashboard` → /api/matrix(11행)·/api/sessions(43개)·/api/timeline·정적 서빙 전부 응답 |
| 4 | 판정 규칙 실데이터 검증 | ✅ | `kakao_recommend_finalize` 2회 호출 100% 실패 → 표본 3회 미만이라 inspect 보류(keep) — 규칙대로 동작 |

특기: 이 머신의 실설정에는 stdio MCP 서버가 없어 `tool_definitions`가 비어 있음 →
defTokens 열이 `-`, savings 0은 **데이터 부재이지 버그 아님**. stdio 서버를 등록하고
`npx mcp-lens scan`을 실행하면 비용 축이 채워진다.

## 수동 항목 (사용자 수행 필요)

1. **VS Code F5 확장 스모크**: `packages/extension`을 VS Code로 열고 F5 → Extension Development Host에서
   상태바에 `Lens: N calls · Xk saved` 표시 확인 → 새 Claude Code 세션에서 MCP 툴콜 발생시켜
   상태바 숫자 갱신(라이브 반영) 확인 → 상태바 클릭 시 리포트 문서 열림 확인
2. **대시보드 브라우저 렌더**: `npm start -w @mcp-lens/dashboard` 후 http://127.0.0.1:43117 접속 —
   매트릭스 테이블(권고 색상)과 세션 타임라인 렌더 확인
3. **/lens-audit**: 플러그인 로컬 설치 후 Claude Code에서 `/lens-audit` 실행 —
   CLI 리포트가 컨텍스트에 올라오고 요약이 생성되는지 확인
