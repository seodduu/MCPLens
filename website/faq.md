# FAQ

This page answers the questions that come up most once you are past setup: what happens when the CLI
and the extension collide, why a report might look thinner than you expect, and what the dashboard's
status is.

## Can I run `mcp-lens scan` while the VS Code extension is open?

Yes, but only one of them writes at a time. Both the extension and the CLI's `scan` and `auth`
commands contend for the same writer lease before they save to `~/.mcplens/lens.db`. If the extension
already holds it, the CLI command refuses to run and prints:

```
The VS Code extension is writing the MCP Lens DB, so this command cannot run right now.
Close the extension window (or the other running mcp-lens) and try again. It may also clear on its own shortly.
```

`mcp-lens report` never needs to refuse: it saves its log backfill when it can take the lease, and
simply skips that save and runs read-only when it cannot, printing the same report either way. Still,
treat the refusal as a safety net rather than a workflow: avoid running the CLI and the extension
against the database at the same time.

## Why does my report only cover the last 30 days by default?

`--days` defaults to 30, matching how long the original client logs (Claude Code, Codex, Gemini CLI)
keep their session history before they expire on their own. The Lens database keeps every observation
it has already ingested permanently, so once you have been running Lens for longer than 30 days you
can pass a larger `--days` value and see further back. What you cannot do is backfill the period
before you installed Lens, because the source logs for that period are already gone.

## Which clients support global actions?

Only Claude Code and Codex. Global actions disable an unused MCP tool by editing that client's own
config file, and Gemini CLI is not a target for that edit. Gemini CLI still gets full scanning, hook
collection, and reporting, it just never has a tool turned off for it automatically. See
[Global Actions](/guide/global-actions) for how the rollout setting controls this per client.

## Is the local dashboard still maintained?

No, it is frozen. Its code and tests still work as of the freeze, and you can still run it with
`npm start -w @mcp-lens/dashboard`, but no new features land there because the VS Code sidebar
absorbed that role. Use the extension's sidebar for anything beyond a quick look; see
[Dashboard](/guide/dashboard) for what still works.

## I installed hooks but my usage is always zero. What's wrong?

If you are on the CLI-only path, this is a current limitation rather than a misconfiguration. The
hooks write each call into the `~/.mcplens/inbox` queue, and the VS Code extension is the only
component that drains that queue into `~/.mcplens/lens.db`. The `mcp-lens` CLI has no drain path at
all, so with the extension never running those records stay queued and never reach the database.

Check it with `mcp-lens hooks status`. If the `pending` count keeps growing instead of returning to
0, that is exactly this situation, and `mcp-lens hooks doctor` raises a warning for the same events:

```bash
mcp-lens hooks status
```

The `pending` line is the one to watch (field names below are real, the number is illustrative):

```
  pending: 128
```

Nothing is lost while they wait. Run the [VS Code extension](/guide/vscode-extension) once and it
drains the whole queue. Until then, the only usage `mcp-lens report` can show is what it recovers by
parsing each client's own session logs, which is a separate path from the inbox. See
[How It Works](/concepts/how-it-works) for both paths in full.

If you are already running the extension and the `calls` column is still zero, the cause is
per-client. Codex in particular needs its hook hash trusted; see the next question.

## My Codex hooks are installed but no events show up. What's wrong?

Codex skips plugin-bundled hooks, including MCP Lens's, until you trust their current
hook-definition hash. Run `mcp-lens hooks doctor codex` to check:

```bash
mcp-lens hooks doctor codex
```

```
[WARNING] codex codex-trust-unapproved: Codex hook trust is not approved; review it with /hooks.
```

If you see that warning, open `/hooks` inside a Codex session, review the MCP Lens hook definition,
and trust its current hash. Start a new Codex session afterward, since the hook state only takes
effect on the next session. Review the hash again whenever the plugin updates and the hash changes.

## Why did `npx mcp-lens` run something I didn't expect?

An unrelated package is already published to npm under the name `mcp-lens`. Plain `npx mcp-lens`
downloads and runs that third-party package whenever there is no local bin available, which is not
this project. MCP Lens itself is not published to npm; you build it from the repository and use the
workspace bin. Always use `npx --no-install mcp-lens` so npx only runs a bin that is already
installed locally, or call the linked bin directly:

```bash
npm install && npm run build
npm link -w @mcp-lens/cli
mcp-lens --help
```
