# Dashboard

By the end of this page you will know how to build and start the local web dashboard, and what to
expect from it. **The dashboard is frozen.** Its code and tests remain in the repository, but no new
features land there, because the VS Code sidebar (the `Cost × Usage Matrix` and `Setup Status` views)
absorbed its role. It still works as of the freeze.

## When to use it instead of the VS Code sidebar

If you already use the [VS Code extension](/guide/vscode-extension), the sidebar is the maintained
path and covers the same cost x usage matrix. Reach for the dashboard only when you want a
browser-based view without opening VS Code, for example when working from the CLI-only path.

## Build and start

```bash
npm run build -w @mcp-lens/dashboard
npm start -w @mcp-lens/dashboard
```

The start command prints the address it is listening on:

```
MCP Lens dashboard: http://127.0.0.1:43117
```

Open `http://127.0.0.1:43117` in a browser. The dashboard reads from the same `~/.mcplens/lens.db`
that `mcp-lens scan` and the hooks write to, so it shows whatever data you have already collected.
See [Quick Start](/quick-start) if you have not run a scan yet, and
[Reading Reports](/guide/reading-reports) for what the columns in the matrix mean.

## Known limitation

Only one writer may hold the database at a time. The CLI takes a writer lease before it writes to
`~/.mcplens/lens.db`, so a second writer (for example the VS Code extension holding the lease) is
refused cleanly instead of silently overwritten. Still, avoid running the CLI and the extension
against the database at the same time. The dashboard reads that same database, so a refused `scan`
means the dashboard keeps showing the previous data until the scan actually succeeds. See the
[FAQ](/faq) for the exact refusal message.
