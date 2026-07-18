# 픽스처 — 실기기 세션 로그 (익명화됨, 2026-07-19 추출)

이 파일들이 어댑터 구현의 **진실**이다. 계획서의 필드명 추정과 다르면 여기에 맞춰라 (CLAUDE.md 공통 규칙).
익명화: 사용자명 → `testuser` 치환만 수행. 구조·필드명·신호는 원본 그대로. 전 줄 유효 JSONL 검증 완료.

## claude/session-toolsearch.jsonl (101KB) — DEFERRED_MEASURABLE 세션

관찰된 실제 형태 (계획서 추정과의 차이 주의):

- 툴콜: `message.content[]`의 `{type:"tool_use", id, name:"mcp__<서버>__<툴>", input}` / `{type:"tool_result", tool_use_id, content}` — 계획서와 일치
- **로드 신호(핵심)**: ToolSearch의 tool_result에 들어 있다:
  `{type:"tool_result", tool_use_id, content:[{type:"tool_reference", tool_name:"mcp__..."}]}`
  같은 레코드의 최상위 `toolUseResult`: `{matches:["mcp__..."], query, total_deferred_tools:43}`
- ToolSearch 호출 자체: `{type:"tool_use", name:"ToolSearch", input:{query:"select:mcp__...", max_results}}`
- 토큰: `message.usage` = `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` — 계획서와 일치
- MCP 툴 실호출 5회 (PlayMCP 서버), ToolSearch 2회

## claude/session-upfront.jsonl (48KB) — 주의: 진짜 UPFRONT 세션이 아님

**이 머신에는 UPFRONT Claude 세션이 존재하지 않는다** (모든 세션에서 Tool Search 활성, deferred 43툴 —
설계문서 4-2 "모드는 세션 단위 속성"의 실증). 이 파일은 mcp__ 문자열이 `attachment` 레코드
(툴 정의 델타)에만 있고 실제 MCP 호출·ToolSearch가 없는 일반 세션이다.
어댑터 파싱 시 기대 결과: toolCalls=0, toolLoads=0, mode=`DEFERRED_OPAQUE`.
용도: 파싱 강건성(깨진 줄) 테스트. Task 2 테스트 중 이 파일로 UPFRONT 모드를 검증하는 부분이 있다면
**테스트 기대값을 DEFERRED_OPAQUE로 수정**해야 한다 (픽스처가 진실).

## codex/rollout-codemode.jsonl (97KB) — DEFERRED_MEASURABLE (코드 모드), lenstest 실험 세션

**함정: 최상위 `type`은 `"event_msg"` 또는 `"response_item"`이고, 이벤트 종류는 `payload.type`에 있다.**
계획서 어댑터 코드의 `rec.type ?? rec.payload?.type`은 항상 최상위를 잡아 이벤트를 놓친다 —
`rec.payload?.type`을 먼저 봐야 한다.

- 툴콜: `payload.type === "mcp_tool_call_end"`,
  `payload.invocation = {server, tool, arguments}` — 계획서와 일치
  **`payload.duration = {secs, nanos}` 객체** (ms 숫자 아님!) → `secs*1000 + nanos/1e6`으로 환산
  `payload.result`는 Rust 스타일: 성공 `{Ok: ...}` / 실패 `{Err: "..."}` — 이 픽스처의 호출은 `{Err: "user cancelled MCP tool call"}` (isError=true 케이스)
- 토큰: `payload.type === "token_count"`, `payload.info.last_token_usage` =
  `{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}` (턴별) /
  `payload.info.total_token_usage` (누적 — 쓰지 말 것)
- 코드 모드 신호: `payload.type === "custom_tool_call"`, `payload.name === "exec"`,
  `payload.input`에 `ALL_TOOLS.filter(...)` 스크립트 원문

## gemini/chat-upfront.jsonl (4KB) — UPFRONT, gemtest(lenstest) 실험 세션

**함정: 계획서가 가정한 `parts[].functionCall`이 아니다.** 실제 구조:

- 파일 시작: 세션 메타 레코드 `{sessionId, projectHash, startTime, ...}` + `{$set: {messages:[...]}}` 패치 레코드 혼재
- 호출: `type:"gemini"` 레코드의 **`toolCalls[]`** = `[{id:"mcp_<서버>_<툴>__<suffix>", name:"mcp_<서버>_<툴>", args, result...}]`
- 응답: `type:"user"` 레코드의 `content[]`의 `{functionResponse: {id, name, response: {output: "<untrusted_context>...</untrusted_context>"}}}` — 래퍼 실증됨
- 토큰: `type:"gemini"` 레코드의 `tokens` = `{input, output, cached, thoughts, tool, total}` — 레코드별 분해 실증
- 지연 신호 없음 → UPFRONT 확정 (설계문서와 일치)
- Task 4 테스트의 `parts[].functionCall` 가정 부분은 이 구조로 수정 필요 (`splitFlattenedName` 규칙 자체는 유효)
