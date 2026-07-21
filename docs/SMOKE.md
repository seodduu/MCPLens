# 실기기 스모크 기록

## Hook 우선 수집 파이프라인 (H12, 2026-07-21)

H0~H11 병합 후 Hook 우선 수집 전 구간을 fixture·package runner 기반으로 검증. 실제
클라이언트 조작(신뢰 승인·크레덧)이 필요한 단계는 절차만 남기고 `BLOCKED`로 표시한다.

### 자동 검증 (통과)

| 항목 | 명령 | 결과 |
|---|---|---|
| 전체 유닛+E2E | `npm test` | ✅ 45 파일 / 534 테스트 통과 (watcher 이중 저장 회귀 수정 포함) |
| Hook 파이프라인 E2E | `npx vitest run packages/core/test/e2e/hook-pipeline.test.ts` | ✅ 11 테스트 — hook-only·log-only·Hook↔log 병합·중복 delivery·corrupt log+healthy Hook·inbox 재시작·3사 통합 매트릭스·native ID당 1호출 |
| 수집 건강도 E2E | `npx vitest run packages/core/test/e2e/hook-health.test.ts` | ✅ 10 테스트 — idle→hook-only→healthy, 3회 미스 degrade / 2회 매치 회복, corrupt log+healthy Hook, 권고 게이트 |
| 롤아웃 `shadow` 불변식 | 위 hook-pipeline.test.ts | ✅ `shadow`(기본)가 로그 전용 권고와 동일; `count-primary`는 hook-only 호출 반영; `health-gated`는 건강도 따라 분기 |
| 3사 패키지 검증 | `node scripts/verify-hook-packages.mjs` | ✅ Claude·Codex·Gemini 모두 PASS (runner byte-identical, exit 0, stdout `{}`, pending 1건, secret 없음) |
| 전체 빌드 | `npm run build` | ✅ core·cli·extension·dashboard 전 워크스페이스 |
| 확장 typecheck·smoke | `npm run typecheck -w mcp-lens && npm run smoke -w mcp-lens` | ✅ activate() 완료, schema.sql·sql-wasm.wasm 해석 |

### 실클라이언트 직렬 스모크 (BLOCKED — 사용자 신뢰/크레덧 필요)

각 클라이언트에 `echo`·`fail` 툴을 가진 더미 stdio 서버 1개를 등록하고 아래를 순차 수행한다.
공유 DB·실프로세스를 쓰므로 병렬 금지.

1. **Claude Code**: `packages/lens-audit-plugin` 로컬 설치 → 새 세션/플러그인 리로드 → `echo`·`fail` 호출 → `mcp-lens hooks status`로 success/failure receipt·transcript 보강·정준 카운트 2 확인. → `BLOCKED: user trust/credential required` (플러그인 설치·세션 조작).
2. **Codex**: `packages/codex-plugin` 등록 → `/hooks`로 해시 신뢰 승인 → 위와 동일 검증. 실제 `codex exec`는 크레덧 소비 → **사용자 요청 없이는 실행 금지**. → `BLOCKED: user trust/credential required`.
3. **Gemini CLI**: `packages/gemini-extension` 설치 → CLI 재시작 → `AfterTool` 발화 확인. → `BLOCKED: user trust/credential required`.
4. **로그 손상 전이**: 활성 세션의 transcript를 손상시켜 Hook만으로 정준 카운트가 유지되는지 확인 (fixture E2E로 대체 검증 완료; 실기기 재확인은 위 단계에 종속). → `BLOCKED`.

## Wave 8 (2026-07-20) — OAuth 실완주 (vercel)

- `mcp-lens auth vercel` → 브라우저 동의 → **"로그인 완료, 툴 30개 · 9,146토큰"** — 인증 필요 서버가 비용 축에 편입
- 재스캔: `- vercel: 30개 툴, 9146 토큰` — 저장 토큰 자동 사용 (인증 스킵 아님, 브라우저 안 뜸)
- `~/.mcplens/oauth/vercel.json` 퍼미션 `-rw-------`(0600) 확인
- 미검증 잔여: 재로그인 반복(redirect_uri 포트 불일치 케이스), 확장 알림 [로그인] 경로 — 백로그 기록

## Wave 9 (2026-07-20) — 절감량 버그 실데이터 검산

- 수정 전: potential=13,452 / actual=25,065 / **saved=−11,613** (음수 — M5+M6+비교집합 합작)
- 수정 후: potential=13,452 / actual=197 / **saved=+13,255** — saved ≥ 0, actual ≤ potential 성립

## Wave 7 (2026-07-20) — 설정 소스 3사 + http 스캔

`node packages/cli/dist/main.js scan` 1회 실행으로 전 경로 검증:

```
발견: claude-user 3개 · claude-project 1개 · codex 1개   ← R1: 소스별 발견
- computer-use: stdio 서버가 아니어서 건너뜀              ← enabled=false/판별불가 스킵
- lenstest: 12개 툴, 936 토큰                            ← 기존 stdio 경로 무손상
- lenstest2: 12개 툴, 936 토큰
- vercel: 인증 필요 — 스킵 (OAuth 지원은 로드맵)           ← R2a: 실제 원격 http에 접속, 401을 정확히 분류
- node_repl: 3개 툴, 1247 토큰                           ← ★ Codex 등록 서버가 비용 축에 처음 편입
```

- http 성공 경로는 유닛(127.0.0.1 루프백 실서버)으로 검증됨; 실원격은 인증 스킵 경로 확인
- ~~남은 수동 항목~~ ✅ 통과 (2026-07-20): `~/.codex/config.toml`에 서버 추가 → 10초 내 자동 감지·TOML 파싱·스캔·DB 적재 확인 (검증 후 원복)

### 실원격 http 완주 (DeepWiki, 2026-07-20 추가 검증)

무인증 공개 http MCP(`https://mcp.deepwiki.com/mcp`)로 등록→스캔→호출→판정 전 구간 실증:

```
deepwiki/ask_question         정의 113tok · 1회 · 응답 766tok → keep
deepwiki/read_wiki_structure  정의  71tok · 0회              → remove
deepwiki/read_wiki_contents   정의  67tok · 0회              → remove
```

원격 http 서버에서 비용·사용 양축 실측 + 판정까지 성립한 첫 사례 (R2a 실전 검증 완료).

## Wave 4 실기기 스모크 기록 (2026-07-19)

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

1. ~~**VS Code F5 확장 스모크**~~ ✅ **통과 (2026-07-19)**: F5 스모크에서 치명 결함 1건 발견·수정 —
   확장이 ESM으로 컴파일되어 확장 호스트(CJS 전용)가 로드 실패하던 문제 → CJS 전환 커밋.
   수정 후 상태바 표시·클릭 리포트 정상. **라이브 반영 실증**: 세션에서 MCP 툴 호출
   (`mcp__ide__getDiagnostics`) → 확장 워처가 실시간 적재(직후 CLI가 "0 files backfilled"인데
   해당 행 존재 = 워처가 먼저 적재했다는 증거) → 상태바 숫자 갱신 확인
2. **대시보드 브라우저 렌더**: `npm start -w @mcp-lens/dashboard` 후 http://127.0.0.1:43117 접속 —
   매트릭스 테이블(권고 색상)과 세션 타임라인 렌더 확인
3. **/lens-audit**: 플러그인 로컬 설치 후 Claude Code에서 `/lens-audit` 실행 —
   CLI 리포트가 컨텍스트에 올라오고 요약이 생성되는지 확인
