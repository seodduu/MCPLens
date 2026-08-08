# Configuration

This page lists where MCP Lens stores its data and every VS Code extension setting, so you can look
up a key or a path without digging through the walkthrough. For what to change and why, see
[the VS Code extension guide](/guide/vscode-extension) and [Global Actions](/guide/global-actions).

## Data locations

Everything MCP Lens keeps lives under `~/.mcplens`. It is never written into your project or into a
client's own config or logs.

| Path | Contents |
| --- | --- |
| `~/.mcplens/lens.db` | The SQLite database: scanned tool definitions, hook-observed calls, and sessions. |
| `~/.mcplens/inbox` | Hook events queued before the extension or CLI moves them into the database. |
| `~/.mcplens/db-writer.lock` | The writer lease file that keeps the extension and the CLI from writing at the same time. |
| `~/.mcplens/oauth` | OAuth tokens and client registrations for authenticated MCP servers, written with owner-only file permissions. |

## Extension settings

Open these from VS Code's Settings UI by searching `MCP Lens`, or edit `settings.json` directly.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mcpLens.reportDays` | number | `30` | Days the status bar summary and reports aggregate over. |
| `mcpLens.reportDetail` | `summary` \| `full` | `summary` | Detail level for the **MCP Lens: Show Report** command. `summary` caps candidate and normal tool lists at 5; items needing action or inspection always show in full either way. |
| `mcpLens.autoScan` | `prompt` \| `always` \| `never` | `never` | Automatic scanning when a new server is detected. `prompt` asks first, `always` scans right away (after your first manual scan from the walkthrough), `never` scans only when you trigger it. |
| `mcpLens.authIgnore` | string[] | `[]` | Server names to stop nagging about sign-in for. Populated automatically by the "Don't ask for this server" button. |
| `mcpLens.oauthClients` | object | `{}` | OAuth client ids for servers that reject automatic client registration, e.g. `{ "github": "Iv1.abc123" }`. Client secrets are never stored here; they go to `~/.mcplens/oauth/clients.json`. |
| `mcpLens.unsupportedServers` | string[] | `[]` | Server names Lens determined it cannot support (for example, servers that reject automatic client registration). Populated automatically; these are hidden from the tree and never prompted again. |
| `mcpLens.inferenceProvider` | `auto` \| `claude` \| `codex` | `auto` | Provider used for dependency analysis. `auto` picks Claude when both CLIs are installed; set this to pin one explicitly. |
| `mcpLens.autoAnalyze` | boolean | `false` | After an automatic scan, analyze new tools with the provider CLI to judge whether each can be turned off independently. This spends the provider's tokens and sends it tool definitions and usage counts. It never runs before you have consented once from the walkthrough. |
| `mcpLens.claudeModel` | string | `haiku` | Claude model used for dependency analysis. |
| `mcpLens.codexModel` | string | `gpt-5.6-luna` | Codex model used for dependency analysis. |
| `mcplens.dependencyAnalysis.rollout` | `off` \| `claude` \| `codex` \| `all` | `off` | Which client is allowed to use global actions (disabling an unused tool by editing that client's config file). Analysis, cache, and details stay available at every value, including `off`. Gemini CLI is never allowed here; global actions do not support it. |

::: tip
`mcplens.dependencyAnalysis.rollout` uses a different (lowercase) settings namespace than every other
key on this page. That is not a typo, it is the exact key VS Code reads; double-check the casing if
you set it by hand in `settings.json`.
:::
