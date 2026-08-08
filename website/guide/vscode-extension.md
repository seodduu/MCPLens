# VS Code Extension

By the end of this page the extension is installed, you have walked through its onboarding, and
the MCP Lens icon in the activity bar shows your own cost x usage matrix. This is the main
distribution path: scanning, hook installation, reports and dependency analysis all live inside
the extension, so no separate CLI install is needed.

## Requirements

- Node.js 20 or later.
- VS Code 1.90 or later.

## Install

The extension is not published to the VS Code Marketplace yet. Build the `.vsix` yourself and
install it locally.

```bash
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm run package -w mcp-context-lens     # creates packages/extension/*.vsix
code --install-extension packages/extension/mcp-context-lens-<version>.vsix
```

Substitute `<version>` with whatever version `npm run package` printed into the `.vsix` file name.
`code --install-extension` prints a line confirming the extension was installed successfully.

## Run the onboarding walkthrough

Reopen VS Code. The MCP Lens icon appears in the activity bar, and the onboarding walkthrough
opens automatically. It has four steps, in order:

1. **Scan** the MCP servers configured for your clients, to measure how many tokens each tool
   definition costs.
2. **Install hooks** for the clients you use, so real call counts start replacing the zeros in the
   report.
3. **Dependency analysis**, which asks an LLM to judge which tools are safe to filter or remove
   given the servers actually attached (see the consent choice below before this step runs).
4. **Enable global actions**, which lets the extension edit a client config file to turn tools off,
   once you explicitly allow it.

Once onboarding is done, the activity bar icon holds two views: `Cost × Usage Matrix` and
`Setup Status`.

## Choose how much runs automatically

The last onboarding step asks one question: should the extension handle a newly attached MCP
server on its own from now on? There are three choices:

- Leave both scanning and dependency analysis to it.
- Leave only scanning to it, and run the analysis yourself (analysis spends LLM tokens, so some
  people would rather trigger it deliberately).
- Do both yourself.

Nothing runs automatically before you answer this question. Once it is on, only servers you attach
afterward are picked up automatically; it reuses the consent already on file and does not ask
again. Withdraw consent at any time with the `MCP Lens: Withdraw Inference Consent` command, which
also stops the automatic analysis. Automatic scanning and automatic analysis can be turned off
individually with the `mcpLens.autoScan` and `mcpLens.autoAnalyze` settings.

## What stays local

Everything is stored in `~/.mcplens/lens.db` (SQLite) on your machine. MCP Lens collects session,
turn and call IDs, the client name, server and tool names, observation time, call duration and
whether a call errored, plus the token counts of the scanned tool definitions. It never collects
conversation bodies, prompts, tool inputs, tool responses, assistant response bodies or source
code. The only feature that leaves your machine is dependency analysis, which sends only tool
definitions and aggregated usage counts to the LLM provider you picked in walkthrough step 3.

Original client logs are always read-only: MCP Lens never modifies or moves them.

## Next steps

To turn the `calls` column from zero into real numbers, install hooks for
[Claude Code](/guide/claude-code), [Codex](/guide/codex) or [Gemini CLI](/guide/gemini-cli), or use
the `MCP Lens: Install Hooks for All Clients` command from inside the extension to do all of them
at once. To understand every column and recommendation in the matrix, see
[Reading Reports](/guide/reading-reports). For what a scan does under the hood, see
[How It Works](/concepts/how-it-works).
