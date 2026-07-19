// packages/extension/src/matrixTree.ts — vscode import 금지 (테스트 가능성)
import type { EngineInput, MatrixRow } from '@mcp-lens/core';
import { buildMatrix, splitByClient, visibleMatrixRows } from '@mcp-lens/core';

export interface LensNode {
  kind: 'client' | 'server' | 'tool';
  id: string;
  label: string;
  description: string;
  tooltip?: string;
  /** 'inspect'|'remove' 등 — 래퍼가 아이콘 선택에 사용 */
  action?: MatrixRow['recommendation']['action'];
  children: LensNode[];
}

/** 성공은 기본값 — 실패가 있을 때만 괄호로 표기 */
function fmtCalls(calls: number, errors: number): string {
  return errors > 0 ? `${calls}회(실패 ${errors})` : `${calls}회`;
}

export function buildTree(input: EngineInput): LensNode[] {
  return splitByClient(input).map(({ client, input: sub }) => {
    // 모드 인지 표시: 지연 로딩 클라이언트에서는 실비용 0인 미사용 툴을 숨긴다
    const rows = visibleMatrixRows(buildMatrix(sub), sub.sessions);
    const byServer = new Map<string, MatrixRow[]>();
    for (const r of rows) {
      if (!byServer.has(r.serverName)) byServer.set(r.serverName, []);
      byServer.get(r.serverName)!.push(r);
    }
    const servers: LensNode[] = [...byServer.entries()].map(([server, rs]) => ({
      kind: 'server',
      id: `${client}/${server}`,
      label: server,
      description: `${fmtCalls(
        rs.reduce((s, r) => s + r.callCount, 0),
        rs.reduce((s, r) => s + r.reliability.errorCount, 0),
      )} · ${rs.reduce((s, r) => s + r.responseTokens, 0)}tok`,
      children: rs.map((r): LensNode => ({
        kind: 'tool',
        id: `${client}/${server}/${r.toolName}`,
        label: r.toolName,
        description: `${fmtCalls(r.callCount, r.reliability.errorCount)} · ${r.responseTokens}tok · ${r.recommendation.action}`,
        tooltip: r.recommendation.reason,
        action: r.recommendation.action,
        children: [],
      })),
    }));
    const totalCalls = rows.reduce((s, r) => s + r.callCount, 0);
    const totalErrors = rows.reduce((s, r) => s + r.reliability.errorCount, 0);
    const totalTokens = rows.reduce((s, r) => s + r.responseTokens, 0);
    return {
      kind: 'client' as const, id: client, label: client,
      description: `세션 ${sub.sessions.length}개 · 총 ${fmtCalls(totalCalls, totalErrors)} · ${totalTokens}tok`,
      children: servers,
    };
  });
}
