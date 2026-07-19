# MCP Lens

MCP context accounting for AI coding clients. MCP Lens automatically collects
MCP tool usage from **Claude Code**, **Codex**, and **Gemini CLI**, then shows
you what each server and tool actually costs versus how often you use it.

## What it does

- **Status bar** — a live summary of recent MCP calls and the tokens you saved.
- **Sidebar** — an activity-bar view with a client ▸ server ▸ tool tree, each
  tool tagged with a keep / inspect / remove recommendation.
- **Report** — run **MCP Lens: Show Report** for a per-client Markdown breakdown
  of calls, response tokens, definition tokens, and recommendations.

## Zero config

Just install and go. MCP Lens auto-detects which clients are installed, reads
their logs (read-only), and backfills past sessions on startup. There is nothing
to set up and no account required.

## Settings

- **`mcpLens.reportDays`** (default `30`) — how many days the status summary and
  report aggregate. Original client logs expire after ~30 days, but the Lens
  database keeps history permanently, so longer windows still work.

## Definition tokens

Response-token accounting works out of the box. To also measure how many tokens
each tool's **definition** costs (its schema, injected into every prompt), run:

```
npx mcp-lens scan
```

This probes your configured MCP servers and records definition token counts,
which then appear in the report and sidebar recommendations.
