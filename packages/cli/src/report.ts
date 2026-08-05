import type { MatrixRow } from '@mcp-lens/core';

export interface Savings {
  potentialTokens: number;
  actualTokens: number;
  savedTokens: number;
}

export type ReportFormat = 'table' | 'ai' | 'json';

export function formatReport(rows: MatrixRow[], savings: Savings, format: ReportFormat): string {
  switch (format) {
    case 'json':
      return formatJson(rows, savings);
    case 'ai':
      return formatAi(rows, savings);
    case 'table':
    default:
      return formatTable(rows, savings);
  }
}

function formatJson(rows: MatrixRow[], savings: Savings): string {
  return JSON.stringify({ rows, savings }, null, 2);
}

const COLUMNS = ['server', 'tool', 'defTokens', 'calls', 'respTokens', 'loaded/sessions', 'errorRate', 'errorTokens', 'action', 'confidence', 'reason'] as const;

function rowCells(row: MatrixRow): string[] {
  return [
    row.serverName,
    row.toolName,
    row.definitionTokens == null ? '-' : String(row.definitionTokens),
    String(row.callCount),
    String(row.responseTokens),
    `${row.loadedSessionCount}/${row.sessionCount}`,
    row.reliability.errorRate == null ? '-' : `${Math.round(row.reliability.errorRate * 100)}%`,
    String(row.reliability.failedResponseTokens),
    row.recommendation.action,
    row.recommendation.confidence,
    row.recommendation.reason,
  ];
}

function formatTable(rows: MatrixRow[], savings: Savings): string {
  const table = [COLUMNS as unknown as string[], ...rows.map(rowCells)];
  const widths = COLUMNS.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  const lines = table.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  '));
  lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  lines.push('');
  lines.push(
    `savings: potential=${savings.potentialTokens} actual=${savings.actualTokens} saved=${savings.savedTokens}`,
  );
  return lines.join('\n');
}

/**
 * Reason compressor for the ai format only.
 *
 * Repeating the same sentence on every row only grows the tokens the consumer (Claude) reads;
 * the verdict is unchanged. So the two repeated chunks move out of the table:
 *  1) the shared server basis (serverBasis): carried once per server.
 *  2) the tail of the per-tool reason (effect + caveat): when the sentence differs only in its
 *     numbers, it is carried once as a template (T#) and the row keeps only its own number
 *     (the accumulated cost).
 * It computes nothing. This is a pure display abbreviation that picks and joins the pieces core
 * already produced.
 */

/** The only number that differs per row. It stays in the row; the rest of the sentence becomes a template. */
const COST_PATTERN = /accumulated cost [\d,]+ tokens/u;

/** A tail shorter than this saves nothing as a template and only obscures the meaning. */
const TEMPLATE_MIN_LENGTH = 30;

/** Joins pieces with the same rule as core's joinReason (a single period). */
function joinParts(parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => p != null && p.trim() !== '')
    .map((p) => p.trim().replace(/\.+$/u, ''))
    .join('. ');
}

interface ReasonIndex {
  /** server -> the basis every row of that server shares. Servers without a shared basis are omitted. */
  serverBasis: Map<string, string>;
  /** tail template -> name (T1, T2, ...) */
  templateName: Map<string, string>;
  /** template name -> template sentence (in order of first appearance) */
  templates: { name: string; text: string }[];
}

/** Splits a per-tool reason tail into "template without the number" and "that row's number". */
function splitTail(row: MatrixRow): { shape: string; cost: string | null } {
  const parts = row.recommendation.reasonParts;
  const tail = joinParts([parts.effect, parts.caveat]);
  const cost = tail.match(COST_PATTERN)?.[0] ?? null;
  return { shape: cost == null ? tail : tail.replace(COST_PATTERN, 'accumulated cost {cost} tokens'), cost };
}

function buildReasonIndex(rows: MatrixRow[]): ReasonIndex {
  // Shared server basis: if the sentence differs within one server (should not happen, defensive), keep it in the table.
  const perServer = new Map<string, Set<string>>();
  for (const row of rows) {
    const basis = row.recommendation.reasonParts.serverBasis;
    if (basis == null || basis.trim() === '') continue;
    const set = perServer.get(row.serverName) ?? new Set<string>();
    set.add(basis.trim());
    perServer.set(row.serverName, set);
  }
  const serverBasis = new Map<string, string>();
  for (const [server, set] of perServer) {
    if (set.size === 1) serverBasis.set(server, [...set][0]);
  }

  // Tail templates: only tails used twice or more get a name. A single use is shorter left inline.
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const row of rows) {
    const { shape } = splitTail(row);
    if (shape.length < TEMPLATE_MIN_LENGTH) continue;
    if (!counts.has(shape)) order.push(shape);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  const templateName = new Map<string, string>();
  const templates: { name: string; text: string }[] = [];
  for (const shape of order) {
    if ((counts.get(shape) ?? 0) < 2) continue;
    const name = `T${templates.length + 1}`;
    templateName.set(shape, name);
    templates.push({ name, text: shape });
  }
  return { serverBasis, templateName, templates };
}

/** Row reason shared by the table and the recommendation list, minus the shared sentence and repeated tail. */
function rowReason(row: MatrixRow, index: ReasonIndex): string {
  const parts = row.recommendation.reasonParts;
  const head =
    parts.serverBasis != null && !index.serverBasis.has(row.serverName)
      ? joinParts([parts.serverBasis, parts.basis])
      : parts.basis;
  const { shape, cost } = splitTail(row);
  const name = index.templateName.get(shape);
  if (name == null) return joinParts([head, shape.replace('{cost}', cost ?? '')]) || '-';
  const ref = cost == null ? name : `${name} (${cost})`;
  return joinParts([head, ref]) || '-';
}

function aiRowCells(row: MatrixRow, index: ReasonIndex): string[] {
  const cells = rowCells(row);
  cells[cells.length - 1] = rowReason(row, index);
  return cells;
}

function formatAi(rows: MatrixRow[], savings: Savings): string {
  const index = buildReasonIndex(rows);
  const lines: string[] = [];
  lines.push('# MCP Lens Audit');
  lines.push('');
  lines.push(
    `potential tokens ${savings.potentialTokens} / actual tokens ${savings.actualTokens} / savable tokens ${savings.savedTokens}`,
  );
  lines.push('');
  lines.push(
    'How to read: a row reason is (the shared server basis) followed by (the row basis). ' +
      'The shared basis applies to every action=filter-server row of that server. ' +
      'A marker like T1 in a row reason expands to the same-named sentence under "Row reason templates", ' +
      'and the number in parentheses is that row\'s own value, which goes into the {cost} slot of the template.',
  );

  if (index.serverBasis.size > 0) {
    lines.push('');
    lines.push('## Shared server basis');
    for (const [server, basis] of index.serverBasis) {
      lines.push(`- ${server}: ${basis}`);
    }
  }

  if (index.templates.length > 0) {
    lines.push('');
    lines.push('## Row reason templates');
    for (const t of index.templates) {
      lines.push(`- ${t.name}: ${t.text}`);
    }
  }

  lines.push('');
  lines.push('| server | tool | defTokens | calls | respTokens | loaded/sessions | errorRate | errorTokens | action | confidence | reason |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${aiRowCells(row, index).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Recommendations');
  const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const actionable = rows
    .filter((r) => r.recommendation.action !== 'keep' && r.recommendation.action !== 'unknown')
    .sort((a, b) => RANK[a.recommendation.confidence] - RANK[b.recommendation.confidence]);
  const bullet = (row: MatrixRow) =>
    `- [${row.recommendation.action}·${row.recommendation.confidence}] ${row.serverName}/${row.toolName}: ${rowReason(row, index)} (${row.recommendation.evidenceLabel})`;

  const confirmed = actionable.filter((r) => r.recommendation.confidence !== 'low');
  const candidates = actionable.filter((r) => r.recommendation.confidence === 'low');

  if (actionable.length === 0) {
    lines.push('- No particular recommendations');
  } else if (confirmed.length === 0) {
    lines.push('- No confirmed recommendations. The candidates below get confirmed as observation accumulates');
  } else {
    for (const row of confirmed) lines.push(bullet(row));
  }

  if (candidates.length > 0) {
    lines.push('');
    lines.push('### Candidates (not enough observation)');
    for (const row of candidates) lines.push(bullet(row));
  }

  const inspects = rows.filter((r) => r.recommendation.action === 'inspect');
  lines.push('');
  lines.push('## Failing tools to inspect');
  if (inspects.length === 0) {
    lines.push('- No failing tools');
  } else {
    for (const row of inspects) {
      lines.push(
        `- ${row.serverName}/${row.toolName}: ${rowReason(row, index)}`,
      );
    }
  }
  return lines.join('\n');
}
