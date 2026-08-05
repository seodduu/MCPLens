---
description: "Audit wasted MCP tool context: analyze the cost x usage matrix and its recommendations, then propose actions"
allowed-tools: Bash(npx --no-install mcp-lens:*)
---

Run the following command to obtain the MCP Lens audit report:

!`npx --no-install mcp-lens report --days 30 --format ai`

`--no-install` is deliberate. This command runs **only a locally installed mcp-lens CLI** and never
downloads anything from the npm registry automatically, because the registry holds an unrelated
package of the same name.

If the command fails with something like `could not determine executable to run` or
`npx canceled due to missing package`, the CLI is not installed. Do not invent a report: pass the
installation guidance below to the user verbatim and stop.

- If they cloned the MCPLens repository: run `npm install && npm run build` at the repository root.
  Running this command from the repository root (or any directory under it) then picks up
  `node_modules/.bin/mcp-lens`.
- To use it outside the repository, link the bin globally with `npm link -w @mcp-lens/cli`.
- For most users the VS Code extension (MCP Context Lens) is the easier path. It shows the same
  data in the sidebar and needs no CLI installation.

Once you have the report, use it to:

1. Summarize the tools recommended for removal (remove) in a table with the expected token savings
2. For any filter-server recommendation, propose the concrete way to filter those tools in that client's config
3. Include the evidence label (measured / lower-bound estimate / assumed full load) so the trust level of each number is explicit

If every definition token count (defTokens) in the report is '-', the MCP server definitions have
not been scanned yet. Tell the user to run `npx --no-install mcp-lens scan` first to fill
tool_definitions.

If the user agrees, help them edit the config (always back it up first).
