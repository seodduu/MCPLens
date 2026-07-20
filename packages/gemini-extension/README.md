# MCP Lens for Gemini CLI

This extension captures local-only MCP accounting metadata from Gemini CLI hook events. It discards sensitive payload fields, including `tool_input`, `tool_response`, `llmContent`, and `returnDisplay`. It uses only its bundled `scripts/hook-runner.mjs` and dependency-free `runtime/`; it never downloads a runtime, opens the MCP Lens database, or uses the network. Events are atomically queued under `~/.mcplens/inbox`, and Gemini's original logs are never modified or moved.

## Install

Install the extension from its local directory:

```sh
gemini extensions install /absolute/path/to/packages/gemini-extension
```

Restart Gemini CLI after installing so it loads the extension and hook registration.

## Passive hook contract

Each command reads one hook payload from stdin, records metadata locally, exits successfully, and writes only `{}` to stdout. Diagnostics go to stderr. The hooks never use blocking exit behavior.

## Disable

Disable capture without removing the extension:

```sh
gemini extensions disable mcp-lens
```

Restart Gemini CLI after changing the extension state.

Uninstall completely with Gemini CLI's extension uninstall command, then restart
Gemini CLI. Disabling or uninstalling stops new capture without changing already
queued local metadata or any original Gemini logs.
