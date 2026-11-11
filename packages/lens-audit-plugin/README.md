# MCP Lens plugin for Claude Code

A plugin that collects MCP call metadata locally through the official Claude Code lifecycle hooks
and runs an MCP tool context waste audit with the `/lens-audit` slash command.

## Local hook collection

It uses only the bundled `scripts/hook-runner.mjs` and `runtime/`. The hook reads the stdin payload
and records atomically into `~/.mcplens/inbox` the minimum metadata of an MCP call: client, session,
server, tool and timestamp. It never stores `tool_input`, `tool_response`, prompts or response
bodies, and it opens neither the network nor the MCP Lens DB. Normal stdout is always just `{}`,
and it never returns a blocking decision.

After installing or updating, reload the Claude Code plugin and start a new session for the hook
definitions to take effect. To stop collection, disable or uninstall the plugin and start a new
session. MCP Lens never modifies or moves Claude's original transcripts or logs.

## Behaviour

`/lens-audit` runs the following command to bring the report into context:

```bash
npx --no-install mcp-lens report --days 30 --format ai
```

Output contract: a markdown report for AI consumption whose first line is `# MCP Lens Audit`
(provided by the Task 10 CLI).

### The CLI dependency and `--no-install`

This plugin does not bundle the CLI. Only the hook collection runtime is self-contained;
`/lens-audit` needs a separately installed `mcp-lens` executable.

`--no-install` is required for security. The CLI in this repository is the unpublished package
`@mcp-lens/cli` whose bin is merely named `mcp-lens`, while an unrelated package of the same name
really exists in the npm registry. Running `npx mcp-lens` without `--no-install` would download and
execute that third-party code on any machine without a local bin. `--no-install` only checks
locally and never queries the registry.

Without the CLI the command does not work. Install it like this:

```bash
# if you cloned the repository (from the repository root)
npm install && npm run build

# to use it outside the repository, link the bin globally
npm link -w @mcp-lens/cli
```

If you would rather not keep a separate CLI, the VS Code extension (MCP Token Lens) shows the same
data in the sidebar.

From the report, Claude then:

1. Summarizes the tools recommended for removal (remove) in a table with the expected token savings
2. Proposes the concrete way to filter tools in the client config for any filter-server recommendation
3. Includes the evidence label (measured / lower-bound estimate / assumed full load) so the trust level of each number is explicit
4. Helps edit the config once the user agrees (always backing it up first)

## Installation (local)

```bash
claude plugin add /path/to/MCPLens/packages/lens-audit-plugin
```

You can also load it with `--plugin-dir` for testing, without registering a marketplace.

## Layout

```
packages/lens-audit-plugin/
├── .claude-plugin/plugin.json   # plugin manifest
├── commands/lens-audit.md       # /lens-audit command definition
├── hooks/hooks.json             # lifecycle hook registration
├── scripts/hook-runner.mjs      # bundle entry point
├── runtime/                     # dependency-free local capture runtime
└── README.md
```

## Permissions

The command front matter is `allowed-tools: Bash(npx --no-install mcp-lens:*)`. Only
`npx --no-install mcp-lens` subcommands are pre-approved, and forms that come with automatic
registry installation (`npx mcp-lens ...`) do not match the pattern.

## Verification status

End-to-end verification (`/lens-audit` calling the CLI and checking the summary) is only possible
after the CLI (Task 10) is merged, so it happens in the Wave 4 real-device smoke run.
