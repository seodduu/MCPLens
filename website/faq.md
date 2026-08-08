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
