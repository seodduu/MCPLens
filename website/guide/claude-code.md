# Claude Code

By the end of this page Claude Code has the MCP Lens plugin installed, so every MCP tool call in
your sessions is recorded locally and the `calls` column in `mcp-lens report` stops sitting at
zero. You also get the `/lens-audit` slash command, which pulls a fresh report straight into the
conversation.

## The easy way: let the extension do it

If you use the VS Code extension, run its `MCP Lens: Install Hooks for All Clients` command and it
installs this plugin for you. See [VS Code Extension](/guide/vscode-extension). The rest of this
page is for installing it by hand.

## Install the plugin manually

```bash
claude plugin add /path/to/MCPLens-V2/packages/lens-audit-plugin
```

Substitute `/path/to/MCPLens-V2` with the path to your own clone of the repository. This registers
the plugin's hooks and adds the `/lens-audit` slash command. For local testing without registering
a marketplace entry, you can load it with `--plugin-dir` instead.

## What it collects

The plugin uses only its bundled hook runner; it downloads no runtime and opens neither the
network nor the MCP Lens database. For every MCP call it records the minimum: client, session,
server, tool name and timestamp, written atomically into `~/.mcplens/inbox`. It never stores tool
inputs, tool responses, prompts or response bodies, and it never touches Claude's original
transcripts or logs.

## After installing

Reload the Claude Code plugin and start a new session for the hook definitions to take effect.
From that new session, run `/lens-audit` to bring a fresh cost x usage report into context; behind
the scenes it runs `npx --no-install mcp-lens report --days 30 --format ai`, so a separately
installed `mcp-lens` CLI is required for the slash command to work (see
[the CLI reference](/reference/cli)).

To stop collection, disable or uninstall the plugin and start a new session.
