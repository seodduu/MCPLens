# MCP Lens

A local accounting tool that contrasts **how much context the MCP servers attached to your AI coding
client eat on every prompt** with **which of it you actually use**.

Attach one MCP server and every tool definition it has rides along in the prompt of every
conversation. Keep a 40-tool server attached and use 2 of them, and you pay the definition tokens of
the other 38 every time. MCP Lens puts the tokens the definitions cost (the cost) next to the real
call counts (the usage) and states in numbers "what do I turn off and how much is left". The basis
is the definition sizes really scanned and the call records really observed, not guesswork.

For installation, per-client hook setup, the CLI reference and the FAQ, see the documentation site:
**https://seodduu.github.io/MCPLens-V2/**

## Supported clients

| Client | Usage collection | Definition scan | Global actions (turning tools off in the config) |
|---|---|---|---|
| Claude Code | yes (plugin hooks) | yes | yes |
| Codex | yes (plugin hooks) | yes | yes |
| Gemini CLI | yes (extension hooks) | yes | no |

## Requirements

- Node.js 20 or later
- VS Code 1.90 or later (when using the extension)

The CLI takes a writer lease before it writes to `~/.mcplens/lens.db`, so a second writer (for
example the VS Code extension holding the lease) is refused cleanly instead of silently overwritten.
Still, avoid running the CLI and the extension against the database at the same time.

## Development

```bash
npm install
npm run build
npm test                # vitest (packages/*/test/**/*.test.ts)
npx tsc --noEmit -p packages/core/tsconfig.json      # always typecheck per package with -p
```

The root tsconfig uses a references layout, so running `npx tsc --noEmit` with no argument checks
zero files and succeeds. That is a false green: always name the package with `-p`.

## Documentation

- [Documentation site](https://seodduu.github.io/MCPLens-V2/): installation, per-client hook setup, CLI reference, FAQ
- [`MCP-Lens-설계문서-v2.md`](MCP-Lens-설계문서-v2.md): the single source of truth for the domain, collection contract and scope
- [`docs/plans/`](docs/plans/): implementation plans
- [`docs/pitfalls/`](docs/pitfalls/): traps this stack keeps stepping on
- [`docs/BACKLOG.md`](docs/BACKLOG.md): backlog
- [`docs/SMOKE.md`](docs/SMOKE.md): real-environment smoke procedure
- [`CLAUDE.md`](CLAUDE.md): the agent execution conventions

## License

MIT. See [`LICENSE`](LICENSE).
