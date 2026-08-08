# Reading Reports

After this page you can run `mcp-lens report`, read every column of the cost x usage matrix it
prints, and turn that into a decision: which tools to turn off, and how many tokens that frees per
session.

## Run the report

`report` is the CLI's default command. Run it with no arguments and it prints the matrix for the
last 30 days.

```bash
mcp-lens report
```

```
server          tool                                 defTokens  calls  respTokens  loaded/sessions  errorRate  errorTokens  action         confidence  reason
--------------  -----------------------------------  ---------  -----  ----------  ---------------  ---------  -----------  -------------  ----------  ------
knowledge-base  knowledge-base-search                1809       10     124         5/533            0%         0            keep           high        called 10 times
web-search      web-search_web_search                1365       1      96          0/533            0%         0            keep           high        called 1 time
web-search      web-search_place_search              17251      0      0           0/533            -          0            remove         medium      definition 17,251 tokens, 0 calls. small savings, but cleans up the search space. 98 sessions/3d observed, confirmed with more observation
knowledge-base  knowledge-base-query-meeting-notes    5929       0      0           1/533            -          0            filter-server  high        Only 2 of 28 tools used on server knowledge-base. Tool filtering recommended. small savings, but cleans up the search space (loaded but never called, so it pollutes the search space). 441 sessions/19d observed, accumulated cost 2,614,689 tokens. Restorable with one config line

savings: potential=61893 actual=26839 saved=35054
```

This excerpt keeps 4 of the real rows and the summary line, in a keep/remove/filter-server teaching
order rather than the capture's original defTokens-descending order; this is not one command's raw
output. A live run prints one row per tool you have observed, sorted by `defTokens` descending.
Server and tool names are also renamed here to the same generic ones used on the [Quick
Start](/quick-start) page (`web-search` for `brave-search`, `knowledge-base` for `notion`); every
number, column and row is otherwise exactly as captured. If another process (usually the VS Code
extension) is writing to the database at the same moment, `report` still prints the same output,
just read-only; see [Notes on the writer lease](#notes-on-the-writer-lease) below.

## Read the columns

| Column | Meaning |
|---|---|
| `server` / `tool` | The MCP server and tool name, as your client config names them. |
| `defTokens` | Tokens the tool's definition (its JSON schema) costs on every single prompt, once the server is attached. `-` means `mcp-lens scan` has not measured this tool yet. |
| `calls` | How many times this tool was actually called in the window. |
| `respTokens` | Tokens returned by successful calls, summed over the window. |
| `loaded/sessions` | Sessions where the definition was loaded (relevant only to clients with deferred/lazy tool loading) over the total sessions observed. |
| `errorRate` / `errorTokens` | Share of calls that errored, and the response tokens spent on those failing calls. `-` when `calls` is 0: an uncalled tool cannot be graded for reliability. |
| `action` | The recommendation: `keep`, `remove`, `filter-server`, `inspect`, or `unknown`. |
| `confidence` | `high`, `medium`, or `low`, how much observation backs that action. |
| `reason` | Why, in one sentence: the evidence behind `action` and `confidence`. |

## From a row to a decision

The core question the matrix answers is "what do I turn off and how much is left". Read `defTokens`
first, since that is what you pay on every prompt regardless of whether you call the tool that
session, then check `calls` to see whether you are paying for something you use.

- `keep`: called during the window. Leave it attached.
- `remove`: `defTokens` paid, `calls` is 0. The `reason` states the accumulated cost so far, for
  example the `web-search_place_search` row above: 17,251 tokens per session, never called.
- `filter-server`: only a few of a server's tools are ever called (the `knowledge-base` row above:
  2 of 28). Turning off individual unused tools on that server, rather than the whole server, is
  recommended.
- `inspect`: a tool that fails often enough to be worth investigating before deciding.
- `unknown`: the scanner has not covered this tool's definition tokens yet.

The `savings` line at the bottom is the total across every row: `potential` is what every tool
attached would cost, `actual` is what you are paying today, and `saved` is `potential - actual`,
the tokens already recovered by tools you removed earlier.

Once you have identified what to turn off, the [Global Actions](/guide/global-actions) guide covers
turning a `remove` or `filter-server` recommendation into an actual config change for Claude Code or
Codex.

## Change the time window

`--days` aggregates only the last *n* days. It defaults to 30 and must be a positive number, for
example `mcp-lens report --days 7`. The table shape and columns stay identical; only `calls`,
`respTokens`, `errorRate`/`errorTokens`, and the `savings` line narrow to that window.

An invalid value is rejected rather than silently falling back to the default:

```bash
mcp-lens report --days 0
```

```
invalid --days value: "0"
Pass a number greater than 0 (e.g. --days 30).
```

## Format for pasting into an AI

`--format ai` prints the same matrix as compact Markdown, with repeated reason text pulled out into
a shared basis and numbered templates instead of repeated on every row. It is meant to be pasted
straight into a chat with Claude, Codex, or any other assistant to ask "which of these should I turn
off".

```bash
mcp-lens report --format ai
```

```markdown
# MCP Lens Audit

potential tokens 61893 / actual tokens 26839 / savable tokens 35054

## Shared server basis
- knowledge-base: Only 2 of 28 tools used on server knowledge-base. Tool filtering recommended.

## Row reason templates
- T2: small savings, but cleans up the search space (loaded but never called, so it pollutes the search space). 441 sessions/19d observed, accumulated cost {cost} tokens. Restorable with one config line

| server | tool | defTokens | calls | respTokens | loaded/sessions | errorRate | errorTokens | action | confidence | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| knowledge-base | knowledge-base-search | 1809 | 10 | 124 | 5/533 | 0% | 0 | keep | high | called 10 times |
| knowledge-base | knowledge-base-query-meeting-notes | 5929 | 0 | 0 | 1/533 | - | 0 | filter-server | high | T2 (accumulated cost 2,614,689 tokens) |

## Recommendations
- [filter-server·high] knowledge-base/knowledge-base-query-meeting-notes: T2 (accumulated cost 2,614,689 tokens) (measured)
```

`mcp-lens report --format json` prints the same rows and the `savings` object as a single JSON
document (`{ "rows": [...], "savings": {...} }`), for scripting. Each row carries the same fields as
the table columns above, plus the full evidence behind the recommendation.

An unsupported value is rejected the same way `--days` is:

```bash
mcp-lens report --format csv
```

```
invalid --format value: "csv"
Pass one of table, ai, json.
```

## Notes on the writer lease

`scan` and `auth` write to the database and take a writer lease that only one process can hold at a
time; they refuse to run while the VS Code extension holds it. `report` never needs to write, so it
always runs, either saving a small backfill when it can take the lease, or staying fully read-only
when it cannot. The output is identical either way.

The same matrix, and the same columns, appear inside VS Code without running any command; see the
[VS Code Extension](/guide/vscode-extension) guide. For how the numbers themselves are collected
and computed, see [How It Works](/concepts/how-it-works).
