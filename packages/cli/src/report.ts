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

const COLUMNS = ['server', 'tool', 'defTokens', 'calls', 'respTokens', 'loaded/sessions', '실패율', '실패토큰', 'action', '확신', 'reason'] as const;

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

function formatAi(rows: MatrixRow[], savings: Savings): string {
  const lines: string[] = [];
  lines.push('# MCP Lens Audit');
  lines.push('');
  lines.push(
    `잠재 토큰 ${savings.potentialTokens} / 실제 사용 토큰 ${savings.actualTokens} / 절약 가능 토큰 ${savings.savedTokens}`,
  );
  lines.push('');
  lines.push('| server | tool | defTokens | calls | respTokens | loaded/sessions | 실패율 | 실패토큰 | action | 확신 | reason |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${rowCells(row).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 권고');
  const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const actionable = rows
    .filter((r) => r.recommendation.action !== 'keep' && r.recommendation.action !== 'unknown')
    .sort((a, b) => RANK[a.recommendation.confidence] - RANK[b.recommendation.confidence]);
  const bullet = (row: MatrixRow) =>
    `- [${row.recommendation.action}·${row.recommendation.confidence}] ${row.serverName}/${row.toolName}: ${row.recommendation.reason} (${row.recommendation.evidenceLabel})`;

  const confirmed = actionable.filter((r) => r.recommendation.confidence !== 'low');
  const candidates = actionable.filter((r) => r.recommendation.confidence === 'low');

  if (actionable.length === 0) {
    lines.push('- 특별한 권고 사항 없음');
  } else if (confirmed.length === 0) {
    lines.push('- 확정 권고 없음 — 관찰량이 쌓이면 아래 후보가 확정된다');
  } else {
    for (const row of confirmed) lines.push(bullet(row));
  }

  if (candidates.length > 0) {
    lines.push('');
    lines.push('### 후보 (관찰 부족)');
    for (const row of candidates) lines.push(bullet(row));
  }

  const inspects = rows.filter((r) => r.recommendation.action === 'inspect');
  lines.push('');
  lines.push('## 불량 툴 점검 권고');
  if (inspects.length === 0) {
    lines.push('- 불량 툴 없음');
  } else {
    for (const row of inspects) {
      lines.push(
        `- ${row.serverName}/${row.toolName}: ${row.recommendation.reason}`,
      );
    }
  }
  return lines.join('\n');
}
