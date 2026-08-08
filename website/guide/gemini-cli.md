# Gemini CLI

By the end of this page Gemini CLI has the MCP Lens extension installed, so every MCP tool call in
your Gemini CLI sessions is recorded locally and the `calls` column in `mcp-lens report` stops
sitting at zero for servers you use through Gemini CLI.

## The easy way: let the VS Code extension do it

If you use the VS Code extension, run its `MCP Lens: Install Hooks for All Clients` command and it
installs this extension for you. See [VS Code Extension](/guide/vscode-extension). The rest of
this page is for installing it by hand.

## Install the extension manually

```sh
gemini extensions install /absolute/path/to/packages/gemini-extension
```

Substitute `/absolute/path/to` with the absolute path to your clone of the repository. Restart
Gemini CLI afterward so it loads the extension and its hook registration.

## What it collects

The extension captures local-only MCP accounting metadata from Gemini CLI hook events, discarding
sensitive payload fields including `tool_input`, `tool_response`, `llmContent` and
`returnDisplay`. It uses only its bundled hook runner, never downloads a runtime, and never opens
the MCP Lens database or the network. Events are atomically queued under `~/.mcplens/inbox`, and
Gemini's original logs are never modified or moved.

## After installing

Restart Gemini CLI so the extension and its hooks load.

To pause collection without removing the extension, disable it and restart again:

```sh
gemini extensions disable mcp-lens
```

To remove it entirely, uninstall it with Gemini CLI's extension uninstall command and restart.
Disabling or uninstalling only stops new capture; it does not touch metadata already queued or any
original Gemini logs.
