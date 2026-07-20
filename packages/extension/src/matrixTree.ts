// packages/extension/src/matrixTree.ts — vscode import 금지 (테스트 가능성)
import type { EngineInput, ManagedServer, MatrixRow, RecommendationConfidence } from '@mcp-lens/core';
import { buildMatrix, mcpDenyRule, splitByClient, visibleMatrixRows } from '@mcp-lens/core';

export interface LensNode {
  kind: 'client' | 'server' | 'tool';
  id: string;
  label: string;
  description: string;
  tooltip?: string;
  /** 'inspect'|'remove' 등 — 래퍼가 아이콘 선택에 사용 */
  action?: MatrixRow['recommendation']['action'];
  /** 확신 등급 — low는 아이콘 강조에서 제외한다 */
  confidence?: RecommendationConfidence;
  /** deny/서버 토글용 — 서버·툴 노드에 채움 */
  client?: string;
  serverName?: string;
  toolName?: string;
  /** claude-code 하위에만 존재. false = 차단됨(✕). undefined = 토글 불가 */
  enabled?: boolean;
  children: LensNode[];
}

/** 성공은 기본값 — 실패가 있을 때만 괄호로 표기 */
function fmtCalls(calls: number, errors: number): string {
  return errors > 0 ? `${calls}회(실패 ${errors})` : `${calls}회`;
}

/** 사용 이력 없는 managed 서버 → 0회 서버 노드 (스펙 1-2: 설정된 서버는 항상 표시) */
function zeroUsageServerNodes(managed: ManagedServer[], usedNames: Set<string>): LensNode[] {
  return managed.filter((s) => !usedNames.has(s.name)).map((s): LensNode => ({
    kind: 'server',
    id: `claude-code/${s.name}`,
    label: s.name,
    description: s.enabled ? '0회 · 0tok' : '0회 · 0tok · 차단됨',
    client: 'claude-code', serverName: s.name, enabled: s.enabled,
    children: [],
  }));
}

export function buildTree(input: EngineInput, deniedRules: Set<string> = new Set(),
  managedServers: ManagedServer[] = []): LensNode[] {
  const managed = new Map(managedServers.map((s) => [s.name, s]));
  const roots = splitByClient(input).map(({ client, input: sub }) => {
    // 모드 인지 표시: 지연 로딩 클라이언트에서는 실비용 0인 미사용 툴을 숨긴다
    const rows = visibleMatrixRows(buildMatrix(sub), sub.sessions);
    const byServer = new Map<string, MatrixRow[]>();
    for (const r of rows) {
      if (!byServer.has(r.serverName)) byServer.set(r.serverName, []);
      byServer.get(r.serverName)!.push(r);
    }
    const servers: LensNode[] = [...byServer.entries()].map(([server, rs]) => {
      const serverEnabled = client === 'claude-code' ? managed.get(server)?.enabled : undefined;
      const desc = `${fmtCalls(
        rs.reduce((s, r) => s + r.callCount, 0),
        rs.reduce((s, r) => s + r.reliability.errorCount, 0),
      )} · ${rs.reduce((s, r) => s + r.responseTokens, 0)}tok`;
      return {
        kind: 'server' as const,
        id: `${client}/${server}`,
        label: server,
        description: serverEnabled === false ? `${desc} · 차단됨` : desc,
        client, serverName: server, enabled: serverEnabled,
        children: rs.map((r): LensNode => {
          // 서버가 꺼져 있으면 툴 단위 토글은 무의미 — 메뉴 숨김(enabled 미부여)
          const enabled = client === 'claude-code' && serverEnabled !== false
            ? !deniedRules.has(mcpDenyRule(server, r.toolName)) : undefined;
          // 확신 낮은 삭제 권고는 확정이 아니라 후보 — 판정이 아니라 표시만 강등한다
          const { action, confidence } = r.recommendation;
          const actionLabel =
            confidence === 'low' && (action === 'remove' || action === 'filter-server')
              ? `${action}?(후보)` : action;
          const toolDesc = `${fmtCalls(r.callCount, r.reliability.errorCount)} · ${r.responseTokens}tok · ${actionLabel}`;
          return {
            kind: 'tool',
            id: `${client}/${server}/${r.toolName}`,
            label: r.toolName,
            description: enabled === false ? `${toolDesc} · 차단됨` : toolDesc,
            tooltip: r.recommendation.reason,
            action,
            confidence,
            client, serverName: server, toolName: r.toolName,
            enabled,
            children: [],
          };
        }),
      };
    });
    if (client === 'claude-code') {
      servers.push(...zeroUsageServerNodes(managedServers, new Set(byServer.keys())));
    }
    const totalCalls = rows.reduce((s, r) => s + r.callCount, 0);
    const totalErrors = rows.reduce((s, r) => s + r.reliability.errorCount, 0);
    const totalTokens = rows.reduce((s, r) => s + r.responseTokens, 0);
    return {
      kind: 'client' as const, id: client, label: client,
      description: `세션 ${sub.sessions.length}개 · 총 ${fmtCalls(totalCalls, totalErrors)} · ${totalTokens}tok`,
      children: servers,
    };
  });
  // 기간 내 claude-code 세션이 없어도 설정된 서버는 표시한다 (스펙 1-2)
  if (managedServers.length > 0 && !roots.some((r) => r.id === 'claude-code')) {
    roots.push({
      kind: 'client', id: 'claude-code', label: 'claude-code',
      description: '세션 0개 · 총 0회 · 0tok',
      children: zeroUsageServerNodes(managedServers, new Set()),
    });
  }
  return roots;
}
