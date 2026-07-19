// packages/extension/src/matrixTree.ts — vscode import 금지 (테스트 가능성)
import type { EngineInput, MatrixRow } from '@mcp-lens/core';
import { buildMatrix, splitByClient } from '@mcp-lens/core';

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

export function buildTree(input: EngineInput): LensNode[] {
  return splitByClient(input).map(({ client, input: sub }) => {
    const rows = buildMatrix(sub)
      .filter((r) => r.callCount > 0 || r.definitionTokens != null);
    const byServer = new Map<string, MatrixRow[]>();
    for (const r of rows) {
      if (!byServer.has(r.serverName)) byServer.set(r.serverName, []);
      byServer.get(r.serverName)!.push(r);
    }
    const servers: LensNode[] = [...byServer.entries()].map(([server, rs]) => ({
      kind: 'server',
      id: `${client}/${server}`,
      label: server,
      description: `${rs.reduce((s, r) => s + r.callCount, 0)}회 · ${rs.reduce((s, r) => s + r.responseTokens, 0)}tok`,
      children: rs.map((r): LensNode => ({
        kind: 'tool',
        id: `${client}/${server}/${r.toolName}`,
        label: r.toolName,
        description: `${r.callCount}회 · ${r.responseTokens}tok · ${r.recommendation.action}`,
        tooltip: r.recommendation.reason,
        action: r.recommendation.action,
        children: [],
      })),
    }));
    const totalCalls = rows.reduce((s, r) => s + r.callCount, 0);
    const totalTokens = rows.reduce((s, r) => s + r.responseTokens, 0);
    return {
      kind: 'client' as const, id: client, label: client,
      description: `세션 ${sub.sessions.length}개 · 총 ${totalCalls}회 · ${totalTokens}tok`,
      children: servers,
    };
  });
}
