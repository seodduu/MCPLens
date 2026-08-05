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

/**
 * ai 포맷 전용 근거 압축기.
 *
 * 같은 문장을 행마다 되풀이하면 소비자(Claude)가 읽는 토큰만 늘고 판정은 그대로다.
 * 그래서 되풀이되는 두 덩어리를 표 밖으로 뺀다.
 *  1) 서버 공통 근거(serverBasis): 서버당 한 번만 싣는다.
 *  2) 툴별 근거의 꼬리(effect + caveat): 수치만 다른 같은 문장이면 틀(T#)로 한 번만 싣고
 *     행에는 그 행 고유 수치(누적 부담 토큰)만 남긴다.
 * 계산은 하지 않는다. core가 준 조각을 고르고 잇기만 하는 순수 표시 축약이다.
 */

/** 행마다 달라지는 유일한 수치. 이 자리만 행에 남기고 나머지 문장은 틀로 뺀다. */
const COST_PATTERN = /누적 부담 [\d,]+토큰/u;

/** 이 길이 미만의 꼬리는 틀로 빼도 줄지 않고 뜻만 흐려진다. */
const TEMPLATE_MIN_LENGTH = 30;

/** core의 joinReason과 같은 규칙으로 조각을 잇는다 (마침표 하나로). */
function joinParts(parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => p != null && p.trim() !== '')
    .map((p) => p.trim().replace(/\.+$/u, ''))
    .join('. ');
}

interface ReasonIndex {
  /** 서버 → 그 서버 전 행이 공유하는 근거. 공유가 깨진 서버는 담지 않는다 */
  serverBasis: Map<string, string>;
  /** 꼬리 틀 → 이름(T1, T2 …) */
  templateName: Map<string, string>;
  /** 틀 이름 → 틀 문장 (등장 순서 유지) */
  templates: { name: string; text: string }[];
}

/** 툴별 근거의 꼬리를 "수치를 뺀 틀"과 "그 행의 수치"로 나눈다. */
function splitTail(row: MatrixRow): { shape: string; cost: string | null } {
  const parts = row.recommendation.reasonParts;
  const tail = joinParts([parts.effect, parts.caveat]);
  const cost = tail.match(COST_PATTERN)?.[0] ?? null;
  return { shape: cost == null ? tail : tail.replace(COST_PATTERN, '누적 부담 {누적}토큰'), cost };
}

function buildReasonIndex(rows: MatrixRow[]): ReasonIndex {
  // 서버 공통 근거: 한 서버 안에서 문장이 갈리면(있을 수 없어야 하나 방어) 표 밖으로 빼지 않는다.
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

  // 꼬리 틀: 두 번 이상 쓰이는 것만 이름을 준다. 한 번뿐이면 행에 그대로 두는 편이 짧다.
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

/** 표·권고 목록에 공통으로 쓰는 행 근거. 서버 공통 문장과 되풀이되는 꼬리는 빠진다. */
function rowReason(row: MatrixRow, index: ReasonIndex): string {
  const parts = row.recommendation.reasonParts;
  const head =
    parts.serverBasis != null && !index.serverBasis.has(row.serverName)
      ? joinParts([parts.serverBasis, parts.basis])
      : parts.basis;
  const { shape, cost } = splitTail(row);
  const name = index.templateName.get(shape);
  if (name == null) return joinParts([head, shape.replace('{누적}', cost ?? '')]) || '-';
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
    `잠재 토큰 ${savings.potentialTokens} / 실제 사용 토큰 ${savings.actualTokens} / 절약 가능 토큰 ${savings.savedTokens}`,
  );
  lines.push('');
  lines.push(
    '읽는 법: 한 행의 근거는 (그 서버의 공통 근거) + (행 근거)를 이어 읽은 것이다. ' +
      '공통 근거는 해당 서버의 action=filter-server 행 전부에 적용된다. ' +
      '행 근거의 T1 같은 표시는 아래 "행 근거 틀"의 같은 이름 문장을 그 자리에 펼쳐 읽고, ' +
      '괄호 안 수치는 그 행 고유값이라 틀의 {누적} 자리에 넣는다.',
  );

  if (index.serverBasis.size > 0) {
    lines.push('');
    lines.push('## 서버별 공통 근거');
    for (const [server, basis] of index.serverBasis) {
      lines.push(`- ${server}: ${basis}`);
    }
  }

  if (index.templates.length > 0) {
    lines.push('');
    lines.push('## 행 근거 틀');
    for (const t of index.templates) {
      lines.push(`- ${t.name}: ${t.text}`);
    }
  }

  lines.push('');
  lines.push('| server | tool | defTokens | calls | respTokens | loaded/sessions | 실패율 | 실패토큰 | action | 확신 | reason |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${aiRowCells(row, index).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 권고');
  const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const actionable = rows
    .filter((r) => r.recommendation.action !== 'keep' && r.recommendation.action !== 'unknown')
    .sort((a, b) => RANK[a.recommendation.confidence] - RANK[b.recommendation.confidence]);
  const bullet = (row: MatrixRow) =>
    `- [${row.recommendation.action}·${row.recommendation.confidence}] ${row.serverName}/${row.toolName}: ${rowReason(row, index)} (${row.recommendation.evidenceLabel})`;

  const confirmed = actionable.filter((r) => r.recommendation.confidence !== 'low');
  const candidates = actionable.filter((r) => r.recommendation.confidence === 'low');

  if (actionable.length === 0) {
    lines.push('- 특별한 권고 사항 없음');
  } else if (confirmed.length === 0) {
    lines.push('- 확정 권고 없음. 관찰량이 쌓이면 아래 후보가 확정된다');
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
        `- ${row.serverName}/${row.toolName}: ${rowReason(row, index)}`,
      );
    }
  }
  return lines.join('\n');
}
