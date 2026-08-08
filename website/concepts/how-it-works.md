# How It Works

By the end of this page you will understand the three moving parts behind every number MCP Lens
shows you: the definition scan that measures cost, the hook-based usage collection that measures
calls, and the snapshot storage that keeps both honest over time. For the commands themselves, see
[Quick Start](/quick-start) and the [CLI reference](/reference/cli).

## The two things being measured

MCP Lens contrasts two independent measurements for every tool: how many tokens its definition costs
on every prompt, and how many times it was actually called. Neither measurement depends on the other,
and they are collected by two different mechanisms described below.

## Definition scan: what a tool costs

`mcp-lens scan` (or the extension's onboarding walkthrough) briefly starts each configured MCP server,
calls the standard `tools/list` method on it, and counts the tokens of the returned definitions. That
is the entire operation.

```bash
mcp-lens scan
```

`scan` prints one line per server, `<server>` the server name, the first `<N>` the number of tools
it exposes, and the second `<N>` the total definition tokens across those tools:

```
- <server>: <N> tools, <N> tokens
```

Three properties make this scan safe to run against a live configuration:

- It spends no LLM tokens. Counting definition tokens is local tokenization, not a model call.
- It never edits a client config file. It only reads the configured servers and queries them.
- For stdio servers it starts the process, asks for the tool list, and lets it exit; it does not keep
  the server running or send it any other request.

The result, definition tokens per tool, is stored as a snapshot at scan time. It is not a live
reference back to the server, so a later change to a server's tools does not retroactively change a
past scan's numbers; running `scan` again captures a new snapshot.

## Usage collection: what a tool actually does

Definition cost alone only tells you what a tool would cost if kept. To know whether it is actually
used, MCP Lens needs call records from inside the client, which is what the per-client hooks and
plugins are for (see [Claude Code](/guide/claude-code), [Codex](/guide/codex),
[Gemini CLI](/guide/gemini-cli)).

Each hook writes a small metadata record atomically into `~/.mcplens/inbox` whenever a tool call
happens, and the extension or CLI later moves that record into the database. Three properties keep
this collection path from ever getting in the way of your actual coding session:

- Normal stdout is always `{}`. The hook never returns data that could alter the client's behavior.
- It never blocks the client. A slow or failing write does not delay the tool call it is observing.
- It writes no network traffic and opens no runtime; it only touches the local filesystem.

The record itself is intentionally thin: session, turn and call IDs, the client name, the server and
tool name, the observation time, call duration, and whether the call errored. It does not include the
call's actual input or output.

## What is collected, and what never is

| Collected | Not collected |
|---|---|
| Session, turn and call IDs | Conversation bodies and prompts |
| Client name, server and tool names | Tool inputs (`tool_input`) |
| Observation time, call duration | Tool responses (`tool_response`) |
| Whether the call errored | Assistant response bodies |
| Scanned definition token counts | Source code |

Everything lives locally in `~/.mcplens/lens.db` (SQLite), with `~/.mcplens/inbox` as the
intermediate queue the hooks write to. The original client logs that some clients also produce are
treated as read-only; MCP Lens never modifies or moves them.

## The one exception: dependency analysis

Every measurement described above runs entirely on your machine. Dependency analysis, the feature
that judges whether a tool is safe to turn off, is the single exception: it calls an external LLM
using your own Claude or Codex CLI account, and only after you have reviewed and consented to what it
sends.

What gets transmitted:

- Server and tool names
- Tool description text
- Input schemas
- The result of a local static-reference check between tools
- Call order and co-occurrence counts with session content stripped out
- The list of candidates being analyzed and the judgment instructions

What never gets transmitted:

- User prompts and conversation content
- Source code and file paths
- Tool input values and response bodies
- Auth tokens, environment variables, HTTP headers
- Original session logs and raw hook records

Nothing runs automatically at first. Right after installation the extension neither scans nor
analyzes on its own; the onboarding walkthrough is where you choose the LLM provider, see the
expected cost and transmitted data, and consent. Automatic scanning and automatic analysis are
opt-in from that point, controlled independently, and withdrawing consent stops the automatic
analysis immediately.

## Snapshots, not live references

Every scan and every dependency analysis records the state of the world at the moment it ran:
definition token counts, tool bodies, and analysis results are all stored as snapshots tied to a
timestamp and a definition hash, not as pointers that get reinterpreted later. This is why re-running
`scan` after a server's tools change produces a new row instead of silently altering history, and why
a report from last week still reflects what was true last week.

## Where to go next

- [Quick Start](/quick-start): run the scan and see your first cost x usage matrix.
- [Reading Reports](/guide/reading-reports): what each column and recommended action means.
- [CLI reference](/reference/cli): every command and flag.
- [FAQ](/faq): what is collected, in your own client's words.
