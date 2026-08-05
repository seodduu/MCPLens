import { Fragment } from 'react';
import type { MatrixRow, RecommendationReason } from '@mcp-lens/core';

const ACTION_COLOR: Record<MatrixRow['recommendation']['action'], string> = {
  remove: '#d64545', // red
  'filter-server': '#e08a2e', // orange
  inspect: '#7a5cc4', // purple (inspect)
  keep: '#2e9e5b', // green
  unknown: '#8a8a8a',
};

const ACTION_LABEL: Record<MatrixRow['recommendation']['action'], string> = {
  remove: 'remove',
  'filter-server': 'filter',
  inspect: 'inspect',
  keep: 'keep',
  unknown: 'unknown',
};

/** tool, definition tokens, calls, response tokens, loaded sessions, total sessions, recommendation */
const COLUMN_COUNT = 7;

/** Reason sentences shorter than this are never folded (folding saves nothing and only obscures them). */
const FOLD_MIN_LENGTH = 40;

/**
 * The "tool-only" reason sentence, with the shared server basis (serverBasis) removed.
 * The server-level sentence appears once in the group header, and rows keep only per-tool content.
 * It computes nothing and only picks and joins the pieces core produced (pure display abbreviation).
 */
function toolReasonText(parts: RecommendationReason): string {
  return [parts.basis, parts.effect, parts.caveat]
    .filter((p): p is string => p != null && p.trim() !== '')
    .join(' · ');
}

/**
 * The "shape" of a sentence with its numbers stripped. Consecutive identical shapes say the same
 * thing with different numbers, so they are folded.
 */
function reasonShape(text: string): string {
  return text.replace(/[\d,]+/g, '#');
}

interface ServerGroup {
  serverName: string;
  /** The recommendation sentence shared by this server's tools. null when absent. */
  serverBasis: string | null;
  rows: MatrixRow[];
}

/** Groups rows per server while preserving row order (descending by cost). */
function groupByServer(rows: MatrixRow[]): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const row of rows) {
    let group = groups.get(row.serverName);
    if (!group) {
      group = { serverName: row.serverName, serverBasis: null, rows: [] };
      groups.set(row.serverName, group);
    }
    group.rows.push(row);
    const basis = row.recommendation.reasonParts.serverBasis;
    if (basis != null && group.serverBasis == null) group.serverBasis = basis;
  }
  return [...groups.values()];
}

/**
 * A comma every three digits. Same approach as core's text generation, so a column never mixes formats.
 * `toLocaleString()` is avoided because it depends on the runtime locale.
 */
function withThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The single line kept on a folded row. The number is core's evidence value, only reformatted. */
function shortFacts(row: MatrixRow): string {
  const cost = row.recommendation.evidence.totalObservedCost;
  if (cost != null) return `accumulated cost ${withThousands(cost)} tokens (same recommendation basis as above)`;
  return 'same as above';
}

export interface MatrixTableProps {
  rows: MatrixRow[];
}

export function MatrixTable({ rows }: MatrixTableProps) {
  if (rows.length === 0) {
    return <p>No matrix data to display.</p>;
  }

  const groups = groupByServer(rows);

  return (
    <table className="matrix-table">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Definition tokens</th>
          <th>Calls</th>
          <th>Response tokens</th>
          <th>Loaded sessions</th>
          <th>Total sessions</th>
          <th>Recommendation</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          // Within a server, a shape already shown once is folded to a single number line from the
          // second occurrence on. It is remembered in a set so an unrelated row in between does not unfold it.
          const shownShapes = new Set<string>();
          return (
            <Fragment key={group.serverName}>
              <tr className="server-group-row">
                <th colSpan={COLUMN_COUNT} scope="colgroup">
                  <span className="server-group-name">{group.serverName}</span>
                  <span className="server-group-count">{group.rows.length} tools</span>
                  {group.serverBasis && (
                    <span className="server-group-note">{group.serverBasis}</span>
                  )}
                </th>
              </tr>
              {group.rows.map((row) => {
                const reason = toolReasonText(row.recommendation.reasonParts);
                const shape = `${row.recommendation.action}|${reasonShape(reason)}`;
                // A short sentence ("called 8 times") gains nothing from folding and only gets murkier.
                const folded =
                  reason.length >= FOLD_MIN_LENGTH && shownShapes.has(shape);
                shownShapes.add(shape);
                return (
                  <tr key={`${row.serverName}/${row.toolName}`}>
                    <td className="cell-tool">{row.toolName}</td>
                    <td className="cell-num">
                      {row.definitionTokens != null ? withThousands(row.definitionTokens) : '—'}
                    </td>
                    <td className="cell-num">{withThousands(row.callCount)}</td>
                    <td className="cell-num">{withThousands(row.responseTokens)}</td>
                    <td className="cell-num">{row.loadedSessionCount}</td>
                    <td className="cell-num">{row.sessionCount}</td>
                    <td className="cell-recommendation">
                      <span
                        className="recommendation-badge"
                        style={{ backgroundColor: ACTION_COLOR[row.recommendation.action] }}
                        title={row.recommendation.reason}
                      >
                        {ACTION_LABEL[row.recommendation.action]}
                      </span>
                      <span
                        className={
                          folded ? 'recommendation-reason is-folded' : 'recommendation-reason'
                        }
                        title={row.recommendation.reason}
                      >
                        {folded ? shortFacts(row) : reason}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
