// packages/extension/src/matrixTree.ts — vscode import 금지 (테스트 가능성)
import type {
  CumulativeCost, EngineInput, ManagedServer, MatrixRow, RecommendationConfidence,
} from '@mcp-lens/core';
import {
  buildMatrix, callSessionCounts, cumulativeCost, dominantMode, mcpDenyRule,
  splitByClient, toolCostKey, visibleMatrixRows,
} from '@mcp-lens/core';

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
  /** 로드는 됐으나 호출 0회(검색 공간 오염) — "검색만 됨" 표시용 */
  searchedNotCalled?: boolean;
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

/** 낭비로 판단한 툴 = remove | filter-server (확신 무관, 상태바 ②와 동일 정의) */
function isWaste(r: MatrixRow): boolean {
  const a = r.recommendation.action;
  return a === 'remove' || a === 'filter-server';
}

/** 낭비 툴 수 꼬리표 — 0이면 빈 문자열(붙이지 않음) */
function wasteSuffix(rows: MatrixRow[]): string {
  const n = rows.filter(isWaste).length;
  return n > 0 ? ` · 낭비 ${n}툴` : '';
}

/** 천단위 구분자 — report/markdown.ts:18과 동일 규칙 */
function fmtTok(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')}tok`;
}

/** 지연 로딩 노드의 누적 비용 문구. 정의 미측정이면 응답분만 담겼음을 밝힌다.
 * 상위(서버·클라이언트) 노드는 fmtTok만 쓴다 — 자식 하나만 미측정이어도 AND-fold로
 * 꼬리표가 붙어, 모든 상위 줄에 같은 문구가 반복되며 잡음이 되기 때문이다.
 * 미측정 여부는 원인이 있는 툴 노드에서 확인한다. */
function costText(cost: CumulativeCost): string {
  return cost.definitionMeasured
    ? fmtTok(cost.tokens)
    : `${fmtTok(cost.tokens)}(정의 미측정)`;
}

/**
 * 업프론트 세션의 정의 비용 = 세션당 부담(정의 토큰 그대로, 세션 수 미승산).
 * 업프론트는 매 세션 전 정의가 로드되지만 툴별 로드 이벤트가 남지 않아
 * cumulativeCost의 loadSessions가 0이 되고 누적이 거짓 0tok으로 뭉개진다.
 * 세션 수를 곱하면 세션별 연결 서버 목록이 없는 상태에서 과대계상되므로(설계 유보안 A),
 * 곱하지 않고 "매 세션 이만큼 든다"만 정직하게 표기한다.
 */
function perSessionCost(row: MatrixRow): CumulativeCost {
  return { tokens: row.definitionTokens ?? 0, definitionMeasured: row.definitionTokens != null };
}

/**
 * 노드의 비용 세그먼트 문구.
 * 업프론트: 호출 비용(누적)과 정의 비용(세션당)은 단위가 달라 분리 표기한다 — "호출 X · 정의 Y/세션".
 *   호출 비용은 세션마다 반복되지 않으므로 곱하지 않고 관측 구간 누적을 그대로 쓴다.
 * 지연 로딩: 정의·응답이 같은 누적 단위라 단일 누적값으로 합쳐 표기한다(기존 동작).
 * showUnmeasured=true(툴 노드)면 정의 미측정 꼬리표를 단다 — 상위 노드에서는 잡음이라 생략한다.
 */
function costSegment(
  rows: MatrixRow[], callSessions: Map<string, number>,
  perSession: boolean, showUnmeasured: boolean,
): string {
  if (perSession) {
    const call = rows.reduce((s, r) => s + r.responseTokens, 0);
    const def = sumCosts(rows.map(perSessionCost));
    // 정의 미측정이면 0tok/세션은 거짓 신호 — 토큰·세션 표기 없이 미측정임만 밝힌다.
    const defText = showUnmeasured && !def.definitionMeasured
      ? '정의 미측정'
      : `정의 ${fmtTok(def.tokens)}/세션`;
    return `호출 ${fmtTok(call)} · ${defText}`;
  }
  const cost = sumCosts(rows.map(
    (r) => cumulativeCost(r, callSessions.get(toolCostKey(r.serverName, r.toolName)) ?? 0)));
  return showUnmeasured ? costText(cost) : fmtTok(cost.tokens);
}

/** 누적 비용의 합산 fold — 서버·클라이언트 노드가 공유한다.
 * definitionMeasured는 AND: 표시값을 실측 하한으로 유지하려면 자식 중 하나라도
 * 미측정이면 전체를 미측정으로 표기해야 과대 신뢰를 피할 수 있다. */
function sumCosts(costs: CumulativeCost[]): CumulativeCost {
  return costs.reduce(
    (acc, c) => ({ tokens: acc.tokens + c.tokens,
      definitionMeasured: acc.definitionMeasured && c.definitionMeasured }),
    { tokens: 0, definitionMeasured: true },
  );
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
  managedServers: ManagedServer[] = [], excludeServers: Set<string> = new Set()): LensNode[] {
  // Lens가 지원하지 않는 서버(DCR 거부 등)는 트리 어디에도 나타나지 않는다.
  managedServers = managedServers.filter((s) => !excludeServers.has(s.name));
  const managed = new Map(managedServers.map((s) => [s.name, s]));
  const roots = splitByClient(input).map(({ client, input: sub }) => {
    // 모드 인지 표시: 지연 로딩 클라이언트에서는 실비용 0인 미사용 툴을 숨긴다
    const rows = visibleMatrixRows(buildMatrix(sub), sub.sessions)
      .filter((r) => !excludeServers.has(r.serverName));
    const callSessions = callSessionCounts(sub.calls);
    // 업프론트는 호출(누적)·정의(세션당)를 분리, 지연 로딩은 누적 단일값으로 표기한다.
    const perSession = dominantMode(sub.sessions) === 'UPFRONT';
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
      )} · ${costSegment(rs, callSessions, perSession, false)}${wasteSuffix(rs)}`;
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
              ? `${action} (후보)` : action;
          const toolDesc = `${fmtCalls(r.callCount, r.reliability.errorCount)} · ${costSegment([r], callSessions, perSession, true)} · ${actionLabel}`;
          return {
            kind: 'tool',
            id: `${client}/${server}/${r.toolName}`,
            label: r.toolName,
            description: enabled === false ? `${toolDesc} · 차단됨` : toolDesc,
            tooltip: r.recommendation.reason,
            action,
            confidence,
            searchedNotCalled: r.loadPattern === 'search-pollution',
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
    // 전체 행에서 직접 fold — 접힌 트리에서도 자식(서버) 합과 일치시켜 거짓 0tok을 없앤다
    return {
      kind: 'client' as const, id: client, label: client,
      description:
        `세션 ${sub.sessions.length}개 · 총 ${fmtCalls(totalCalls, totalErrors)} · ${costSegment(rows, callSessions, perSession, false)}${wasteSuffix(rows)}`,
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
