// packages/cli/src/help.ts

export const HELP_TEXT = `mcp-lens: MCP context accounting tool

Usage: mcp-lens <command> [options]

Commands
  report                    print the cost x usage matrix from collected observations (default)
      --days <n>            aggregate only the last n days (default 30, must be > 0)
      --format <f>          output format: table | ai | json (default table)
  scan                      connect to configured MCP servers, scan tool definitions and token counts
      --config <path>       read only this one config file (default: every detected client config)
  auth <serverName>         OAuth login to an http server, then rescan just that server
      --clear               delete the stored credentials
  hooks status              show hook installation state per client
      --json                print JSON
  hooks doctor [client]     diagnose the hook setup (client: claude-code | codex | gemini-cli)
  hook capture --client <c> hook runtime entry point, reads its payload from stdin (not for humans)

  -h, --help                print this help

Notes
  scan and auth write to the DB, so they take the writer lease. They will not run while the
  VS Code extension holds it; close the extension window and try again. report saves its
  backfill when it can take the lease and runs read-only when it cannot (same output either way).
`;

/**
 * Decides whether this invocation is a help request.
 *
 * `hook` is never intercepted here. `mcp-lens hook capture` has a fail-open contract: whatever
 * the arguments, it must print `{}` on stdout and exit 0 so the client session does not break.
 * If help handled that path instead, the hook host would break.
 */
export function isHelpRequest(args: string[]): boolean {
  if (args[0] === 'hook') return false;
  if (args.length === 0) return true;
  if (args[0] === 'help') return true;
  return args.some((a) => a === '--help' || a === '-h');
}
