// packages/extension/src/matrixTree.ts — vscode import 금지 (테스트 가능성)
import type {
  CumulativeCost, EngineInput, ManagedServer, MatrixRow, RecommendationConfidence,
} from '@mcp-lens/core';
import {
  buildMatrix, callSessionCounts, cumulativeCost, dominantMode, mcpDenyRule,
  splitByClient, toolCostKey, visibleMatrixRows, actionAllowedByRollout,
  type DependencyAnalysisRollout,
} from '@mcp-lens/core';
import type { AnalysisRow } from './analysisTree.js';

export interface LensNode {
  kind: 'client' | 'server' | 'tool' | 'hint';
  id: string;
  label: string;
  description: string;
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
  analysisStatus?: AnalysisRow['status'];
  analysisSummary?: string;
  canDisableGlobally?: boolean;
  canRestoreGlobally?: boolean;
  analysisAction?: 'Disable globally…' | 'Restore globally';
  children: LensNode[];
}

/** 성공은 기본값 — 실패가 있을 때만 괄호로 표기 */
function fmtCalls(calls: number, errors: number): string {
  const label = calls === 1 ? 'call' : 'calls';
  return errors > 0 ? `${calls} ${label} (${errors} failed)` : `${calls} ${label}`;
}

/** 낭비로 판단한 툴 = remove | filter-server (확신 무관, 상태바 ②와 동일 정의) */
function isWaste(r: MatrixRow): boolean {
  const a = r.recommendation.action;
  return a === 'remove' || a === 'filter-server';
}

/**
 * 낭비 툴 수 꼬리표. 0이면 빈 문자열(붙이지 않음).
 *
 * 명사를 생략하면 안 된다. 이 꼬리표는 "127.9k tokens" 바로 뒤에 붙으므로
 * "20 waste"는 낭비 토큰 20으로 읽힌다. 상태바와 같은 "wasteful tools"로 쓴다.
 */
function wasteSuffix(rows: MatrixRow[]): string {
  const n = rows.filter(isWaste).length;
  return n > 0 ? ` · ${n} wasteful ${n === 1 ? 'tool' : 'tools'}` : '';
}

/**
 * 트리 전용 토큰 표기. 1만 이상은 k로 줄인다.
 * 트리 description은 비례폭 회색 글씨라 자릿수를 세로로 맞출 수 없어서,
 * 126,604tok 같은 긴 숫자는 비교에 도움이 안 되면서 줄 길이만 먹는다.
 * 리포트(report/markdown.ts)는 전체 자릿수를 유지한다 — 거기서는 정밀도가 결론이다.
 */
function fmtTok(n: number): string {
  const v = Math.round(n);
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k tokens`;
  return `${v.toLocaleString('en-US')} ${v === 1 ? 'token' : 'tokens'}`;
}

/** 지연 로딩 노드의 누적 비용 문구. 정의 미측정이면 응답분만 담긴 하한값이므로 ≥를 붙인다.
 * 상위(서버·클라이언트) 노드는 fmtTok만 쓴다 — 자식 하나만 미측정이어도 AND-fold로
 * 꼬리표가 붙어, 모든 상위 줄에 같은 문구가 반복되며 잡음이 되기 때문이다.
 * 미측정 여부는 원인이 있는 툴 노드에서 확인한다. */
function costText(cost: CumulativeCost): string {
  return cost.definitionMeasured ? fmtTok(cost.tokens) : `≥${fmtTok(cost.tokens)}`;
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
 *   응답 토큰이 0이면(gemini-cli처럼 응답 크기를 못 재는 경우가 흔하다) 호출 쪽을 통째로
 *   생략한다. 앞의 "N calls"가 이미 호출 사실을 말하므로 "3 calls · calls 0tok"은
 *   같은 말을 두 번 하면서 0이라는 빈 값을 싣는 꼴이다. 이때는 한쪽만 남으므로
 *   "calls"/"definition" 라벨도 필요 없다 — /session 접미가 정의임을 이미 밝힌다.
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
    const unmeasured = showUnmeasured && !def.definitionMeasured;
    if (call === 0) {
      return unmeasured ? 'definition unmeasured' : `${fmtTok(def.tokens)}/session`;
    }
    const defText = unmeasured ? 'definition unmeasured' : `definition ${fmtTok(def.tokens)}/session`;
    return `calls ${fmtTok(call)} · ${defText}`;
  }
  const cost = sumCosts(rows.map(
    (r) => cumulativeCost(r, callSessions.get(toolCostKey(r.serverName, r.toolName)) ?? 0)));
  return showUnmeasured ? costText(cost) : fmtTok(cost.tokens);
}

/**
 * 정렬 기준값 — 그 노드가 먹는 토큰 총량.
 * "무엇을 끄면 얼마가 남는가"가 제품의 질문이므로, 등장 순서가 아니라 이 값의
 * 내림차순으로 서버·툴을 배치해 비용 큰 항목이 항상 위에 오게 한다.
 * costSegment와 같은 단위 규칙을 쓴다(업프론트는 호출 누적 + 세션당 정의).
 */
function sortWeight(
  rows: MatrixRow[], callSessions: Map<string, number>, perSession: boolean,
): number {
  if (perSession) {
    return rows.reduce((s, r) => s + r.responseTokens, 0)
      + sumCosts(rows.map(perSessionCost)).tokens;
  }
  return sumCosts(rows.map(
    (r) => cumulativeCost(r, callSessions.get(toolCostKey(r.serverName, r.toolName)) ?? 0))).tokens;
}

/** 비용 내림차순, 동점이면 이름 오름차순 — 데이터가 같으면 자리도 같아야 눈이 따라간다. */
function byCostDesc<T>(weight: (item: T) => number, name: (item: T) => string) {
  return (a: T, b: T): number => weight(b) - weight(a) || name(a).localeCompare(name(b));
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

/**
 * 스캔으로 잰 정의 토큰. 사용 이력이 없어도 이 값은 이미 실측이다.
 *
 * 실측 회귀: 훅을 아직 설치하지 않은 첫 사용자는 스캔 직후 사용 기록이 0인데,
 * 예전에는 이 경로가 서버 이름만 싣고 "0 calls · 0 tokens"를 하드코딩해 방금 잰
 * 정의 토큰을 통째로 버렸다. 스캔했는데 화면이 0을 말하면 도구의 존재 이유가 사라진다.
 *
 * 세션 기록이 없어 업프론트인지 지연 로딩인지 판정할 수 없으므로 "/session"을 붙이지
 * 않는다. 잰 사실만 말하고 세션당 부담 주장은 사용 기록이 생긴 뒤로 미룬다.
 */
function definedTools(definitions: EngineInput['definitions'], serverName: string) {
  return definitions
    .filter((d) => d.serverName === serverName)
    .map((d) => ({ toolName: d.toolName, tokens: d.definitionTokens }))
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.toolName.localeCompare(b.toolName));
}

function definitionSegment(tools: { tokens: number | null }[]): string {
  if (tools.length === 0) return '0 tokens';
  const measured = tools.filter((t) => t.tokens != null);
  if (measured.length === 0) return 'definition unmeasured';
  const sum = measured.reduce((s, t) => s + (t.tokens ?? 0), 0);
  return `definition ${fmtTok(sum)}`;
}

/** 사용 이력 없는 managed 서버 → 0회 서버 노드 (스펙 1-2: 설정된 서버는 항상 표시) */
function zeroUsageServerNodes(
  managed: ManagedServer[], usedNames: Set<string>,
  definitions: EngineInput['definitions'] = [],
): LensNode[] {
  return managed.filter((s) => !usedNames.has(s.name)).map((s): LensNode => {
    const tools = definedTools(definitions, s.name);
    const desc = `0 calls · ${definitionSegment(tools)}`;
    return {
    kind: 'server',
    id: `claude-code/${s.name}`,
    label: s.name,
    description: s.enabled ? desc : `${desc} · Disabled`,
    client: 'claude-code', serverName: s.name, enabled: s.enabled,
    children: tools.map((t): LensNode => ({
      kind: 'tool',
      id: `claude-code/${s.name}/${t.toolName}`,
      label: t.toolName,
      description: `0 calls · ${definitionSegment([t])}`,
      client: 'claude-code', serverName: s.name, toolName: t.toolName,
      children: [],
    })),
    };
  });
}

export function buildTree(input: EngineInput, deniedRules: Set<string> = new Set(),
  managedServers: ManagedServer[] = [], excludeServers: Set<string> = new Set(),
  analysisRows: readonly AnalysisRow[] = [],
  rollout: DependencyAnalysisRollout = 'off',
  isCurrentlyEligible: (client: string, serverName: string, toolName: string) => boolean = () => false,
  hasActiveGlobalAction: (client: string, serverName: string, toolName: string) => boolean = () => false): LensNode[] {
  // Lens가 지원하지 않는 서버(DCR 거부 등)는 트리 어디에도 나타나지 않는다.
  managedServers = managedServers.filter((s) => !excludeServers.has(s.name));
  const managed = new Map(managedServers.map((s) => [s.name, s]));
  const analysisByTool = new Map(analysisRows.map((row) => [`${row.serverName}\u0000${row.toolName}`, row]));
  const roots: LensNode[] = splitByClient(input).map(({ client, input: sub }) => {
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
    const servers: LensNode[] = [...byServer.entries()].sort(byCostDesc(
      ([, rs]) => sortWeight(rs, callSessions, perSession), ([server]) => server,
    )).map(([server, rs]) => {
      const serverEnabled = client === 'claude-code' ? managed.get(server)?.enabled : undefined;
      const desc = `${fmtCalls(
        rs.reduce((s, r) => s + r.callCount, 0),
        rs.reduce((s, r) => s + r.reliability.errorCount, 0),
      )} · ${costSegment(rs, callSessions, perSession, false)}${wasteSuffix(rs)}`;
      return {
        kind: 'server' as const,
        id: `${client}/${server}`,
        label: server,
        description: serverEnabled === false ? `${desc} · Disabled` : desc,
        client, serverName: server, enabled: serverEnabled,
        children: [...rs].sort(byCostDesc(
          (r) => sortWeight([r], callSessions, perSession), (r) => r.toolName,
        )).map((r): LensNode => {
          // 서버가 꺼져 있으면 툴 단위 토글은 무의미 — 메뉴 숨김(enabled 미부여)
          const enabled = client === 'claude-code' && serverEnabled !== false
            ? !deniedRules.has(mcpDenyRule(server, r.toolName)) : undefined;
          // 권고(keep·remove·inspect·filter-server)는 글로 쓰지 않는다. 판정은 아이콘이
          // 전한다(lensTreeProvider의 체크·휴지통·경고·필터). 툴마다 같은 단어가 반복되면
          // 정작 봐야 할 숫자가 밀리고, 낱말 하나로는 왜 그렇게 봤는지도 못 전한다.
          // 확신이 낮으면 아이콘 자체를 억제하므로 "(candidate)" 표기도 필요 없다.
          // 판정 근거는 행을 클릭해 여는 분석 상세와 리포트에 있다.
          const { action, confidence } = r.recommendation;
          const toolDesc = `${fmtCalls(r.callCount, r.reliability.errorCount)} · ${costSegment([r], callSessions, perSession, true)}`;
          const analysis = analysisByTool.get(`${server}\u0000${r.toolName}`);
          // 요약 문장은 줄에 싣지 않는다. status와 같은 말을 길게 되풀이하는 경우가 많고
          // ("Independent" · "Tool a operates independently without being used by other tools."),
          // 한 줄에서 제일 긴 조각이라 옆의 숫자를 화면 밖으로 밀어낸다.
          // 요약은 행을 클릭하면 열리는 분석 상세(openAnalysisDetails)에 그대로 있다.
          const analysisText = analysis ? ` · ${analysis.status}` : '';
          const rolloutAllowed = actionAllowedByRollout(rollout, client);
          const activeAction = hasActiveGlobalAction(client, server, r.toolName);
          const canDisableGlobally = !activeAction && analysis?.canDisableGlobally === true
            && rolloutAllowed && isCurrentlyEligible(client, server, r.toolName);
          const canRestoreGlobally = activeAction && rolloutAllowed;
          return {
            kind: 'tool',
            id: `${client}/${server}/${r.toolName}`,
            label: r.toolName,
            description: enabled === false ? `${toolDesc}${analysisText} · Disabled` : `${toolDesc}${analysisText}`,
            action,
            confidence,
            searchedNotCalled: r.loadPattern === 'search-pollution',
            client, serverName: server, toolName: r.toolName,
            enabled,
            analysisStatus: analysis?.status,
            analysisSummary: analysis?.summary,
            canDisableGlobally,
            canRestoreGlobally,
            analysisAction: canDisableGlobally ? analysis?.action
              : canRestoreGlobally ? 'Restore globally' : undefined,
            children: [],
          };
        }),
      };
    });
    if (client === 'claude-code') {
      servers.push(...zeroUsageServerNodes(
        managedServers, new Set(byServer.keys()), input.definitions));
    }
    const totalCalls = rows.reduce((s, r) => s + r.callCount, 0);
    const totalErrors = rows.reduce((s, r) => s + r.reliability.errorCount, 0);
    // 전체 행에서 직접 fold — 접힌 트리에서도 자식(서버) 합과 일치시켜 거짓 0tok을 없앤다
    return {
      kind: 'client' as const, id: client, label: client,
      description:
        `${sub.sessions.length} sessions · total ${fmtCalls(totalCalls, totalErrors)} · ${costSegment(rows, callSessions, perSession, false)}${wasteSuffix(rows)}`,
      children: servers,
    };
  });
  // 기간 내 claude-code 세션이 없어도 설정된 서버는 표시한다 (스펙 1-2)
  if (managedServers.length > 0 && !roots.some((r) => r.id === 'claude-code')) {
    const servers = zeroUsageServerNodes(managedServers, new Set(), input.definitions);
    const allTools = managedServers.flatMap((s) => definedTools(input.definitions, s.name));
    roots.push({
      kind: 'client', id: 'claude-code', label: 'claude-code',
      description: `0 sessions · total 0 calls · ${definitionSegment(allTools)}`,
      children: servers,
    });
  }
  // 스캔 전이면 트리는 0만 늘어선 채 다음 할 일을 말해 주지 않는다. package.json의
  // viewsWelcome은 트리가 완전히 빌 때만 뜨는데, 서버가 하나라도 설정돼 있으면
  // "0 calls · 0 tokens" 행이 생겨 영영 뜨지 않는다. 그 자리를 이 힌트 행이 메운다.
  // 맨 뒤에 붙인다. 앞에 끼우면 "첫 행은 클라이언트"라는 기존 계약이 깨지고,
  // 스캔 전에는 트리가 짧아 맨 뒤여도 한 화면에 들어온다.
  if (input.definitions.length === 0) {
    roots.push({
      kind: 'hint',
      id: 'hint/scan',
      label: 'Run a scan to measure token cost',
      description: 'No tool definitions measured yet',
      children: [],
    });
  }
  return roots;
}
