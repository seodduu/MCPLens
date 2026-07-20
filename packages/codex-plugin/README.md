# MCP Lens Codex plugin

This plugin registers `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`
lifecycle hooks. MCP Lens records only minimal MCP call metadata locally. Tool
inputs, tool responses, prompt text, and assistant-message bodies are not kept.

The bundled hook command has a two-second timeout. Its runner must write exactly
the valid JSON object `{}` to stdout on success and never return a blocking
decision. The runner at `scripts/hook-runner.mjs` is supplied by the packaging
task.

Codex skips plugin-bundled and other non-managed hooks until the current
hook-definition hash has been reviewed and trusted with `/hooks`. Review the
definition after installation and again whenever that hash changes.
