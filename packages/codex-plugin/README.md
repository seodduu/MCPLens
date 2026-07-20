# MCP Lens Codex plugin

This plugin registers `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`
lifecycle hooks. MCP Lens records only minimal MCP call metadata locally. Tool
inputs, tool responses, prompt text, and assistant-message bodies are not kept.

The plugin uses only its bundled `scripts/hook-runner.mjs` and `runtime/`; it
does not download a runtime or require a global MCP Lens installation. Events
are atomically queued under `~/.mcplens/inbox`. The hook does not open the MCP
Lens database or use the network. Its two-second command timeout is a safety
ceiling. Normal stdout is exactly `{}` and the hook never returns a blocking
decision. Diagnostics use stderr only.

Codex skips plugin-bundled and other non-managed hooks until the current
hook-definition hash has been reviewed and trusted with `/hooks`. Review the
definition after installation and again whenever that hash changes.

After installing or updating the plugin, open `/hooks`, review the MCP Lens hook
definition, and trust its current hash. Start a new Codex session after the hook
state changes. To stop collection, disable or remove the plugin registration;
remove the plugin to uninstall it. MCP Lens leaves Codex's original session logs
untouched.
