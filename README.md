# MCP Lens

A local accounting tool that contrasts **how much context the MCP servers attached to your AI coding
client eat on every prompt** with **which of it you actually use**.

Attach one MCP server and every tool definition it has rides along in the prompt of every
conversation. Keep a 40-tool server attached and use 2 of them, and you pay the definition tokens of
the other 38 every time. MCP Lens puts the tokens the definitions cost (the cost) next to the real
call counts (the usage) and states in numbers "what do I turn off and how much is left". The basis
is the definition sizes really scanned and the call records really observed, not guesswork.

## Supported clients

| Client | Usage collection | Definition scan | Global actions (turning tools off in the config) |
|---|---|---|---|
| Claude Code | yes (plugin hooks) | yes | yes |
| Codex | yes (plugin hooks) | yes | yes |
| Gemini CLI | yes (extension hooks) | yes | no |

## Requirements

- Node.js 20 or later
- VS Code 1.90 or later (when using the extension)

## Installation

### 1. VS Code extension (the main distribution path)

The recommended path for most users. Scanning, hook installation, reports and dependency analysis
all live inside the extension, so no separate CLI installation is needed.

Build and install the `.vsix` yourself.

```bash
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm run package -w mcp-context-lens     # creates packages/extension/*.vsix
code --install-extension packages/extension/mcp-context-lens-<version>.vsix
```

Reopen VS Code after installing and the onboarding walkthrough appears. Follow its four steps
(scan, hook installation, dependency analysis, enabling global actions). The MCP Lens icon in the
activity bar holds two views, `Cost × Usage Matrix` and `Setup Status`.

### 2. Installing hooks and plugins (usage collection)

A definition scan alone only tells you "how expensive this is". To learn "is it actually used", the
hooks have to be installed into the client.

The easiest way is the extension command `MCP Lens: Install Hooks for All Clients`, which performs
the per-client installation for you. Each client then needs one more step:

- **Claude Code**: reload the plugin and start a new session.
- **Codex**: review the MCP Lens hook definitions under `/hooks` and trust the current hash, or the
  hooks will not run. Then start a new session.
- **Gemini CLI**: restart Gemini CLI.

To install by hand, follow the README of each package.

- `packages/lens-audit-plugin/` (Claude Code plugin, including the `/lens-audit` slash command)
- `packages/codex-plugin/` (Codex plugin)
- `packages/gemini-extension/` (Gemini CLI extension)

The hooks are self-contained. They download no runtime, use no network and never open the Lens DB.
They write metadata atomically into `~/.mcplens/inbox` and the extension or the CLI moves it into the
DB. Normal stdout is always `{}` and they never block the client under any circumstance.

### 3. CLI (optional)

The CLI is not published to npm. Build the repository and use the workspace bin, or link it with
`npm link`.

```bash
npm install && npm run build
npm link -w @mcp-lens/cli      # only if you want mcp-lens outside the repository
```

> An unrelated package named `mcp-lens` exists in the registry. Running plain `npx mcp-lens`
> downloads and runs that third-party package whenever there is no local bin.
> Always use the `npx --no-install mcp-lens` form, or call the linked bin directly as above.

## CLI usage

```
mcp-lens <command> [options]
```

| Command | What it does |
|---|---|
| `report` | Prints the cost x usage matrix from the collected observations. The default command with no arguments. |
| `report --days <n>` | Aggregates only the last n days (default 30). |
| `report --format <f>` | Picks the output format: `table` (default), `ai`, `json`. |
| `scan` | Briefly connects to the configured MCP servers, scans the tool definitions and token counts, and stores them. |
| `scan --config <path>` | Reads only this one config file instead of every detected client config. |
| `auth <serverName>` | Performs an OAuth login to an http server, then rescans just that server. |
| `auth <serverName> --clear` | Deletes the stored credentials. |
| `hooks status [--json]` | Shows the hook installation state per client. |
| `hooks doctor [client]` | Diagnoses the hook setup (`claude-code`, `codex`, `gemini-cli`). |
| `hook capture --client <c>` | The hook runtime entry point. It reads its payload from stdin and is not for humans. |

Examples:

```bash
mcp-lens scan                          # collect definition tokens
mcp-lens report --days 30              # cost x usage matrix for the last 30 days
mcp-lens report --format ai            # markdown report an AI reads easily
mcp-lens hooks doctor codex            # diagnose why the Codex hooks are not picked up
```

All `scan` does is start each stdio server briefly and call `tools/list`. It spends no LLM tokens
and never edits a client config file.

## Dashboard (frozen)

The local web dashboard is **frozen**. Its code and tests remain, but no new features land there,
because the VS Code sidebar absorbed that role. It works as of the freeze.

```bash
npm run build -w @mcp-lens/dashboard
npm start -w @mcp-lens/dashboard       # http://127.0.0.1:43117
```

## Data and privacy

All data stays local. It is stored in `~/.mcplens/lens.db` (SQLite), with the intermediate queue the
hooks hand over in `~/.mcplens/inbox`.

**What is collected**: session, turn and call IDs, the client name, the MCP server and tool names,
the observation time, the call duration (`durationMs`), whether it errored (`isError`), and the token
counts of the scanned tool definitions.

**What is not collected**: conversation bodies, prompts, tool inputs (`tool_input`), tool responses
(`tool_response`), assistant response bodies, source code.

The original client logs are treated as read-only. They are never modified or moved.

The dependency analysis is the one exception that calls an external LLM. Only tool definitions and
aggregated usage counts are transmitted: no prompts, tool inputs or outputs, and no source code.

**You start it yourself at first.** Right after installation the extension neither scans nor
analyzes on its own. Walk through the four steps of the onboarding walkthrough. Choosing the LLM
provider for the analysis, being told what is transmitted and the expected cost, and consenting are
all part of it.

**Automatic handling is enabled by one question in the last walkthrough step.** That is where you
decide whether the extension measures and analyzes a new MCP server you attach later. There are
three choices: leave both scanning and analysis to it, leave only scanning to it (analysis spends
tokens, so you would rather run it yourself), or do both yourself. Nothing runs automatically until
you answer.

**Once it is on, only new servers are handled automatically.** Attach a new MCP server and the
extension scans it, then analyzes only the tools not analyzed yet. It reuses the consent already on
file, so it does not ask again, and it **uses the provider and model recorded in that consent**. If
you picked Codex in the walkthrough, the automatic analysis runs on Codex too. With no consent ever
given, the automatic analysis is skipped.

A server that needs a login raises the login notification at that point.

Withdrawing consent with `MCP Lens: Withdraw Inference Consent` **stops the automatic analysis too**.
Turning it back on means running the analysis command yourself. Automatic scanning and automatic
analysis can be turned off individually with `mcpLens.autoScan` and `mcpLens.autoAnalyze`.
Global actions (editing config files to turn tools off) are locked by default and only work when
explicitly allowed through the `mcplens.dependencyAnalysis.rollout` setting.

## Known limitations

- **Do not run a CLI scan while the extension is running.** Only one writer may be attached to the
  DB at a time, and the CLI used not to participate in the writer lease the extension uses. If both
  write at once, one side's records can be silently overwritten and lost. Close VS Code or disable
  the extension while using CLI `scan`/`auth`. (A fix that makes the CLI take the lease is in
  progress. Once it lands, CLI `scan`/`auth` is refused outright while the extension is alive.
  `report` is read-only and is always safe.)
- The original client logs expire after roughly 30 days. The Lens DB keeps its data afterwards, so
  longer periods can still be queried, but the period before Lens was installed cannot be filled in
  retroactively.
- Global actions support only Claude Code and Codex. Gemini CLI is not a target.
- The dashboard is frozen. See the "Dashboard" section above.

## Development

```bash
npm install
npm run build
npm test                # vitest (packages/*/test/**/*.test.ts)
npx tsc --noEmit -p packages/core/tsconfig.json      # always typecheck per package with -p
```

The root tsconfig uses a references layout, so running `npx tsc --noEmit` with no argument checks
zero files and succeeds. That is a false green: always name the package with `-p`.

## Documentation

- [`MCP-Lens-설계문서-v2.md`](MCP-Lens-설계문서-v2.md): the single source of truth for the domain, collection contract and scope
- [`docs/plans/`](docs/plans/): implementation plans
- [`docs/pitfalls/`](docs/pitfalls/): traps this stack keeps stepping on
- [`docs/BACKLOG.md`](docs/BACKLOG.md): backlog
- [`docs/SMOKE.md`](docs/SMOKE.md): real-environment smoke procedure
- [`CLAUDE.md`](CLAUDE.md): the agent execution conventions

## License

MIT. See [`LICENSE`](LICENSE).
