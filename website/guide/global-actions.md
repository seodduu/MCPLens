# Global Actions

After this page you can unlock global actions for Claude Code and/or Codex, turn off a `remove` or
`filter-server` recommendation from the [report](/guide/reading-reports) without hand-editing a
config file, and restore it if you change your mind.

## What a global action is

A global action edits your client's config so a tool is unavailable in every session, not just the
current one. It is the step after the report tells you a tool is safe to drop.

| Client | Global actions |
|---|---|
| Claude Code | supported |
| Codex | supported |
| Gemini CLI | not supported |

Gemini CLI is excluded outright: it is never offered as a target, regardless of the rollout setting
below.

## Global actions are locked by default

The setting `mcplens.dependencyAnalysis.rollout` controls this, and its default is `"off"`. With it
off, MCP Lens computes recommendations and shows them in the report and sidebar as usual, but it
never edits a client config file.

| Value | Effect |
|---|---|
| `off` (default) | Global actions are locked. Lens never edits your client config. |
| `claude` | Allow global actions for Claude Code only. |
| `codex` | Allow global actions for Codex only. |
| `all` | Allow global actions for Claude Code and Codex. |

## Turn it on

Run the command **MCP Lens: Open Global Actions Setting** from the Command Palette
(`Cmd/Ctrl+Shift+P`) and it jumps straight to `mcplens.dependencyAnalysis.rollout` in Settings. Pick
`claude`, `codex`, or `all` there.

Alternatively, set it directly in `settings.json`:

```json
{
  "mcplens.dependencyAnalysis.rollout": "all"
}
```

## Disable a tool globally

With the rollout set, open the MCP Lens sidebar tree, select the tool you want to turn off, and run
**MCP Lens: Disable Globally**. The exact file it edits depends on the client the tool belongs to.

::: code-group

```jsonc [~/.claude/settings.json]
{
  "permissions": {
    "deny": [
      "mcp__web-search__web-search_place_search"
    ]
  }
}
```

```toml [~/.codex/config.toml]
[mcp_servers.web-search]
disabled_tools = ["web-search_place_search"]
```

:::

You do not write these yourself; MCP Lens adds the one rule for the one tool you picked, backs up
the file first, and records the change so it can later remove exactly that rule and nothing else.

## Why a tool can be ineligible

**MCP Lens: Disable Globally** can refuse even with the rollout on, most often because the
dependency analysis has not marked the tool `Independent` yet, or because the same server name
resolves to different commands/URLs across your config sources (an identity conflict Lens will not
guess through). Re-run **MCP Lens: Analyze Dependencies** or resolve the naming conflict, then try
again.

## Restore a tool

Run **MCP Lens: Restore Globally** on a disabled tool to remove the rule Lens added. If you edited
that config file yourself in the meantime and it no longer matches what Lens recorded, the restore
is refused with a conflict rather than silently overwriting your edit.

## Caveats worth knowing

- **Claude Code's `bypassPermissions` mode** can skip the permission-rule layer entirely, so a
  global deny is not an absolute guarantee under that mode.
- **Codex** applies `disabled_tools` after `enabled_tools`; an organization-managed policy that
  takes precedence over your user config can make a Lens rule not apply, in which case Lens reports
  the client as policy-restricted rather than pretending the write succeeded.
