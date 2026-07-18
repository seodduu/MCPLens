# 백로그 — 최종 리뷰 이월 Minor (2026-07-19, MVP 머지 비차단)

| # | 항목 | 내용 | 발화 조건 |
|---|---|---|---|
| M4 | 엔진 row 합집합에 loads 미포함 | row가 definitions∪calls로만 생성되어 "로드만 되고 정의·호출 없는" 툴은 search-pollution으로 표면화 안 됨 | 스캐너가 커버 못한 서버에서만 발생. loads를 합집합에 추가하면 해소 |
| M5 | sessionSavings 혼합 클라이언트 과소계상 | actualTokens = max(이름조인합, 직접기록합) — Claude(조인)와 Codex(직접)가 공존하면 합이 아니라 max라 절감량 과대표시 | 단일 클라이언트에선 정확. 키 겹침 없는 합산으로 교체 |
| M6 | loadsSince가 날짜 인자 무시 | tool_loads에 타임스탬프 컬럼이 없어 전 기간 로드가 집계됨 (calls/sessions는 필터됨) | sessions 조인으로 기간 필터 추가 또는 한계 문서화 |
| M8 | 대시보드 리로드 동시성 + 미검증 경로 | mtime 가드를 두 요청이 동시에 통과하면 이중 reopen/swap 가능(로컬 단일 사용자 5초 폴링에선 위험 극소). 파일 리로드 브랜치는 유닛테스트 미커버(실기기 검증만 됨) | mutex 한 줄 + 리로드 경로 테스트 추가 |
