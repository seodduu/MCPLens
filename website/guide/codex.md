# Codex

By the end of this page Codex has the MCP Lens plugin installed and its hooks trusted, so every
MCP tool call in your Codex sessions is recorded locally and the `calls` column in
`mcp-lens report` stops sitting at zero for servers you use through Codex.

## The easy way: let the extension do it

If you use the VS Code extension, run its `MCP Lens: Install Hooks for All Clients` command and it
installs this plugin for you. See [VS Code Extension](/guide/vscode-extension). The rest of this
page is for installing it by hand.

## Install the plugin manually

Codex plugins are registered from a local marketplace snapshot, which the repository build
produces. Build the repository first, then register that snapshot with the `codex` CLI.

```bash
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build                                          # also builds packages/extension/dist/codex-marketplace
codex plugin marketplace add packages/extension/dist/codex-marketplace
codex plugin add mcp-lens@mcplens
```

`codex plugin list --json` should now list `mcp-lens@mcplens` under `installed`.

## What it collects

The plugin registers `SessionStart`, `PreToolUse`, `PostToolUse` and `Stop` hooks, using only its
bundled hook runner. It never downloads a runtime, opens the MCP Lens database or uses the
network, and it records only minimal MCP call metadata, atomically queued under
`~/.mcplens/inbox`. Tool inputs, tool responses, prompt text and assistant-message bodies are not
kept, and Codex's original session logs are left untouched.

## After installing

Codex skips plugin-bundled hooks until their current hook-definition hash is reviewed and trusted.
Open `/hooks` inside Codex, review the MCP Lens hook definition, and trust its current hash; do
this again whenever the hash changes. Start a new Codex session after the hook state changes.

To stop collection, disable or remove the plugin registration; removing it uninstalls the plugin.
