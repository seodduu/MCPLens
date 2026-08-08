# Quick Start

By the end of this page you will have MCP Lens installed and will have seen your own cost x usage
matrix: the table that lines up how many tokens each MCP tool definition costs against how often it
is actually called.

## Requirements

- Node.js 20 or later.
- VS Code 1.90 or later, only if you use the VS Code extension.

## Install

Pick one path. The VS Code extension is the main distribution: scanning, hook installation, reports
and dependency analysis all live inside it, so no separate CLI install is needed. The CLI is
optional and useful for scripting or a terminal-only workflow. The extension path's last line
installs the `.vsix` that `npm run package` just built; replace `<version>` with the version printed
in that step's output (it matches the file that appears under `packages/extension/`).

::: code-group

```bash [VS Code extension (recommended)]
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm run package -w mcp-context-lens     # creates packages/extension/*.vsix
code --install-extension packages/extension/mcp-context-lens-<version>.vsix
```

```bash [CLI]
npm install && npm run build
npm link -w @mcp-lens/cli      # only if you want mcp-lens outside the repository
```

:::

::: warning
An unrelated package named `mcp-lens` exists in the registry. Running plain `npx mcp-lens`
downloads and runs that third-party package whenever there is no local bin.
Always use the `npx --no-install mcp-lens` form, or call the linked bin directly as above.
:::

## Verify

::: code-group

```md [VS Code extension]
Reopen VS Code. The MCP Lens icon appears in the activity bar, and the onboarding walkthrough opens
automatically.
```

```bash [CLI]
npx --no-install mcp-lens --help
```

:::

The CLI command prints, among other lines:

```
mcp-lens: MCP context accounting tool
```

## Your first audit in 5 minutes

### 1. Scan your MCP servers

```bash
mcp-lens scan
```

`scan` briefly starts each configured stdio server and calls `tools/list` on it. It spends no LLM
tokens and never edits a client config file, so it is safe to run against a live configuration.

### 2. Read the cost x usage matrix

```bash
mcp-lens report
```

`report` prints the definition token cost of every tool next to how often it was actually called, and
a recommended action per row. These are real rows from a run; the `loaded/sessions`, `errorRate` and
`errorTokens` columns are cut here for width, and your own terminal shows all of them:

```
server          tool                                defTokens  calls  respTokens  action         confidence  reason
--------------  ----------------------------------  ---------  -----  ----------  -------------  ----------  ---------------------------------------------------
web-search      web-search_place_search             17251      0      0           remove         medium      definition 17,251 tokens, 0 calls...
knowledge-base  knowledge-base-query-meeting-notes  5929       0      0           filter-server  high        Only 2 of 28 tools used on server knowledge-base...
weather-tools   get_weather                         74         4      83          keep           high        called 4 times

savings: potential=61893 actual=26839 saved=35054
```

That last line is the number that matters: with everything the report currently sees as removable
turned off, `saved` tokens stop riding along on every prompt.

## Next steps

You have now seen the matrix. To make `calls` reflect real usage instead of staying at zero for
everything, install the hooks for your client next: [Claude Code](/guide/claude-code),
[Codex](/guide/codex), or [Gemini CLI](/guide/gemini-cli). To understand what the columns and actions
mean in detail, see [Reading Reports](/guide/reading-reports). For how the scan and the hooks fit
together under the hood, see [How It Works](/concepts/how-it-works).
