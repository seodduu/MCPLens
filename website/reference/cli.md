# CLI

This page lists every `mcp-lens` command with its exact flags and defaults, so you can look one up
without re-running `--help`. For a first run end to end, see [Quick Start](/quick-start); for what
the report's columns mean, see [Reading Reports](/guide/reading-reports).

All commands share the same entry point:

```
mcp-lens <command> [options]
```

Only `scan` and `auth` write to the database, so only they take the writer lease and contend with the
VS Code extension. `report` opens the database but only ever writes an incidental log backfill; if the
extension holds the lease it silently skips that save and still prints the same report, read-only.

## report

```
mcp-lens report [--days <n>] [--format <f>]
```

Prints the cost x usage matrix: every scanned tool's definition token cost next to how often it was
actually called, with a recommended action per row. This is the default command, so plain `mcp-lens`
runs it too.

| Option | Default | Meaning |
| --- | --- | --- |
| `--days <n>` | `30` | Aggregate only the last `n` days. Must be a number greater than 0. |
| `--format <f>` | `table` | Output format: `table`, `ai`, or `json`. |

```bash
mcp-lens report --days 14 --format table
```

```
server        tool                   defTokens  calls  respTokens  action         confidence  reason
------------  ---------------------  ---------  -----  ----------  -------------  ----------  ------
web-search    place_search           17251      0      0           remove         medium      definition 17,251 tokens, 0 calls
knowledge-base query-meeting-notes   5929       0      0           filter-server  high        Only 2 of 28 tools used on server knowledge-base. Tool filtering recommended.

savings: potential=61893 actual=26839 saved=35054
(0 session files backfilled)
```

`--format ai` prints the same data as Markdown, with row-reason templates deduplicated into a
"Row reason templates" section above the table. This is the format the `/lens-audit` slash command
consumes, and it is also the shape to paste into a chat with an LLM when you want it to reason about
which tools to turn off.

## scan

```
mcp-lens scan [--config <path>]
```

Connects briefly to every configured MCP server, calls `tools/list`, and records each tool's
definition token count. It spends no LLM tokens and never edits a client config file.

| Option | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | every detected client config | Read and scan only this one config file instead of auto-discovering every client's config. |

```bash
mcp-lens scan
```

```
discovered: 2 claude-code, 1 codex
- web-search: 9 tools, 26198 tokens
- knowledge-base: 15 tools, 24157 tokens
```

`scan` writes to the database, so it takes the writer lease. If the VS Code extension currently holds
it, the command prints a message and exits with a non-zero status instead of overwriting the
extension's observations:

```
The VS Code extension is writing the MCP Lens DB, so this command cannot run right now.
Close the extension window (or the other running mcp-lens) and try again. It may also clear on its own shortly.
```

## auth

```
mcp-lens auth <serverName> [--clear]
```

Runs an OAuth login for one HTTP MCP server, then rescans just that server. Use it for servers that
require sign-in before `tools/list` succeeds.

| Option | Default | Meaning |
| --- | --- | --- |
| `--clear` | off | Delete the stored credentials for `<serverName>` instead of logging in. |

```bash
mcp-lens auth github
```

```
github: 12 tools, 3410 tokens
```

Like `scan`, `auth` writes to the database and takes the writer lease, but only around the final save;
the browser sign-in itself happens before the lease is requested, so a slow login does not block the
extension. If the server refuses automatic client registration (for example GitHub's or Figma's
remote MCP servers), the command prints the config key to set an OAuth client id under, or the header
to use a personal access token instead.

## hooks status

```
mcp-lens hooks status [--json]
```

Shows per-client hook installation state: whether the hook package is installed, whether its trust
state is approved (Codex only), whether the bundled runner is present, the last observed hook event,
how many events are still pending, and an overall health.

| Option | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Print the same data as JSON instead of the human-readable form. |

```bash
mcp-lens hooks status
```

```
Claude Code
  package: installed
  trust: not-required
  runner: ready
  last event: 2026-08-09T02:14:31.000Z
  pending: 0
  fallback: unknown
  health: healthy
```

## hooks doctor

```
mcp-lens hooks doctor [client]
```

Diagnoses the hook setup and prints one line per finding, worst severity first. Pass a client name to
check only that one.

| Argument | Values |
| --- | --- |
| `client` (optional) | `claude-code`, `codex`, `gemini-cli` |

```bash
mcp-lens hooks doctor codex
```

```
[WARNING] codex codex-trust-unapproved: Codex hook trust is not approved; review it with /hooks.
```

## hook capture

```
mcp-lens hook capture --client <c>
```

This is the hook runtime's entry point, not a command for humans to run directly. Claude Code, Codex,
and Gemini CLI invoke it as a lifecycle hook, piping the hook payload to it on stdin. It decodes the
payload, queues an observation into `~/.mcplens/inbox`, and always prints `{}` on stdout and exits 0,
even when the payload is invalid or `--client` is missing or unrecognized. This fail-open contract
exists so a bug here can never block your coding session.
