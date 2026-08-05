# Fixtures: real-device session logs (anonymized, captured 2026-07-19)

These files are the **truth** for the adapter implementations. Where the field names guessed in a
plan differ, follow these (the shared rule in CLAUDE.md).
Anonymization: only the user name was replaced with `testuser`. Structure, field names and signals
are exactly as captured. Every line was verified as valid JSONL.

## claude/session-toolsearch.jsonl (101KB): a DEFERRED_MEASURABLE session

The shapes actually observed (mind the differences from what the plan assumed):

- Tool calls: `{type:"tool_use", id, name:"mcp__<server>__<tool>", input}` / `{type:"tool_result", tool_use_id, content}` in `message.content[]`, matching the plan
- **Load signal (the important one)**: it lives in the tool_result of ToolSearch:
  `{type:"tool_result", tool_use_id, content:[{type:"tool_reference", tool_name:"mcp__..."}]}`
  and the top-level `toolUseResult` of the same record: `{matches:["mcp__..."], query, total_deferred_tools:43}`
- The ToolSearch call itself: `{type:"tool_use", name:"ToolSearch", input:{query:"select:mcp__...", max_results}}`
- Tokens: `message.usage` = `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, matching the plan
- 5 real MCP tool calls (the PlayMCP server) and 2 ToolSearch calls

## claude/session-upfront.jsonl (48KB): note, not a real UPFRONT session

**No UPFRONT Claude session exists on this machine** (Tool Search is active in every session with 43
deferred tools, demonstrating design doc 4-2, "the mode is a per-session property"). In this file the
mcp__ strings appear only in `attachment` records (tool definition deltas), with no real MCP call and
no ToolSearch.
Expected adapter parse result: toolCalls=0, toolLoads=0, mode=`DEFERRED_OPAQUE`.
Purpose: the base file for parsing robustness tests (the file itself contains no broken line; the
Task 2 test prepends a broken line itself with `'not-json\n' + fixture`). If any part of the Task 2
tests verifies UPFRONT mode with this file, **the expected value must be changed to
DEFERRED_OPAQUE** (the fixture is the truth).

## codex/rollout-codemode.jsonl (97KB): DEFERRED_MEASURABLE (code mode), a lenstest experiment session

**Trap: the top-level `type` is `"event_msg"` or `"response_item"`, and the event kind lives in
`payload.type`.**
The `rec.type ?? rec.payload?.type` in the plan's adapter code always picks the top level and misses
the event: `rec.payload?.type` has to come first.

- Tool calls: `payload.type === "mcp_tool_call_end"`,
  `payload.invocation = {server, tool, arguments}`, matching the plan
  **`payload.duration = {secs, nanos}` is an object** (not a millisecond number), converted with `secs*1000 + nanos/1e6`
  `payload.result` is Rust-style: success `{Ok: ...}` / failure `{Err: "..."}`. The call in this fixture is `{Err: "user cancelled MCP tool call"}` (an isError=true case)
- Tokens: `payload.type === "token_count"`, `payload.info.last_token_usage` =
  `{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}` (per turn) /
  `payload.info.total_token_usage` (cumulative, do not use)
- Code mode signal: `payload.type === "custom_tool_call"`, `payload.name === "exec"`, with the raw
  `ALL_TOOLS.filter(...)` script in `payload.input`

## gemini/chat-upfront.jsonl (4KB): UPFRONT, a gemtest (lenstest) experiment session

**Trap: it is not the `parts[].functionCall` the plan assumed.** The real structure:

- File start: a session metadata record `{sessionId, projectHash, startTime, ...}` mixed with `{$set: {messages:[...]}}` patch records
- Calls: **`toolCalls[]`** on a `type:"gemini"` record = `[{id:"mcp_<server>_<tool>__<suffix>", name:"mcp_<server>_<tool>", args, result...}]`
- Responses: `{functionResponse: {id, name, response: {output: "<untrusted_context>...</untrusted_context>"}}}` in the `content[]` of a `type:"user"` record; the wrapper is confirmed
- Tokens: `tokens` on a `type:"gemini"` record = `{input, output, cached, thoughts, tool, total}`, confirmed to be per-record
- No deferred signal, so UPFRONT is confirmed (matching the design doc)
- The `parts[].functionCall` assumption in the Task 4 tests needs to change to this structure (the `splitFlattenedName` rule itself holds)
