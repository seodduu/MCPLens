// packages/extension/src/matrixTree.ts (never import vscode, for testability)
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
  /** 'inspect'|'remove' and so on; the wrapper uses it to pick an icon */
  action?: MatrixRow['recommendation']['action'];
  /** Confidence grade; low is excluded from icon emphasis */
  confidence?: RecommendationConfidence;
  /** Loaded but never called (search-space pollution); used for the "search only" marker */
  searchedNotCalled?: boolean;
  /** For deny and server toggles; filled on server and tool nodes */
  client?: string;
  serverName?: string;
  toolName?: string;
  /** Only under claude-code. false = blocked (x). undefined = not toggleable */
  enabled?: boolean;
  analysisStatus?: AnalysisRow['status'];
  analysisSummary?: string;
  canDisableGlobally?: boolean;
  canRestoreGlobally?: boolean;
  analysisAction?: 'Disable globally…' | 'Restore globally';
  children: LensNode[];
}

/** Success is the default; only failures are shown in parentheses */
function fmtCalls(calls: number, errors: number): string {
  const label = calls === 1 ? 'call' : 'calls';
  return errors > 0 ? `${calls} ${label} (${errors} failed)` : `${calls} ${label}`;
}

/** Tools judged wasteful = remove | filter-server (regardless of confidence, same definition as status bar item 2) */
function isWaste(r: MatrixRow): boolean {
  const a = r.recommendation.action;
  return a === 'remove' || a === 'filter-server';
}

/**
 * Suffix with the wasteful tool count. Empty string when 0 (nothing appended).
 *
 * The noun must not be dropped. This suffix sits right after "127.9k tokens", so
 * "20 waste" reads as 20 wasted tokens. It uses "wasteful tools", same as the status bar.
 */
function wasteSuffix(rows: MatrixRow[]): string {
  const n = rows.filter(isWaste).length;
  return n > 0 ? ` · ${n} wasteful ${n === 1 ? 'tool' : 'tools'}` : '';
}

/**
 * Token formatting for the tree only. 10,000 and up are shortened with k.
 * A tree description is proportional grey text, so digits cannot be aligned vertically, and a long
 * number like 126,604tok eats line width without helping comparison.
 * The report (report/markdown.ts) keeps full precision: there, precision is the conclusion.
 */
function fmtTok(n: number): string {
  const v = Math.round(n);
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k tokens`;
  return `${v.toLocaleString('en-US')} ${v === 1 ? 'token' : 'tokens'}`;
}

/** Accumulated cost wording for a deferred-loading node. With unmeasured definitions it holds only
 * the response part, so it is a lower bound and gets a >=. Parent nodes (server, client) use fmtTok
 * alone: with the AND-fold, one unmeasured child tags every parent line with the same suffix and it
 * becomes noise. Whether something is unmeasured is checked on the tool node that causes it. */
function costText(cost: CumulativeCost): string {
  return cost.definitionMeasured ? fmtTok(cost.tokens) : `≥${fmtTok(cost.tokens)}`;
}

/**
 * Definition cost of an upfront session = the per-session charge (definition tokens as they are, not multiplied by sessions).
 * Upfront loads every definition each session but leaves no per-tool load event, so
 * cumulativeCost sees loadSessions = 0 and the accumulation collapses to a false 0tok.
 * Multiplying by the session count would overcount without a per-session list of connected servers
 * (design open question A), so it is not multiplied and only states honestly "this is what it costs each session".
 */
function perSessionCost(row: MatrixRow): CumulativeCost {
  return { tokens: row.definitionTokens ?? 0, definitionMeasured: row.definitionTokens != null };
}

/**
 * Cost segment wording for a node.
 * Upfront: call cost (accumulated) and definition cost (per session) have different units, so they
 *   are shown separately as "calls X · definition Y/session". Call cost does not repeat per session,
 *   so it is not multiplied and uses the accumulation over the observed period as is.
 *   When response tokens are 0 (common where response size cannot be measured, as with gemini-cli)
 *   the call side is dropped entirely: the leading "N calls" already states the calls, so
 *   "3 calls · calls 0tok" says the same thing twice while carrying an empty 0. With only one side
 *   left, the "calls"/"definition" labels are unnecessary too: the /session suffix already marks the definition.
 * Deferred loading: definitions and responses share the same accumulated unit, so they are shown as one accumulated value (legacy behaviour).
 */
function costSegment(
  rows: MatrixRow[], callSessions: Map<string, number>,
  perSession: boolean, showUnmeasured: boolean,
): string {
  if (perSession) {
    const call = rows.reduce((s, r) => s + r.responseTokens, 0);
    const def = sumCosts(rows.map(perSessionCost));
    // With unmeasured definitions, 0tok/session is a false signal: say only that it is unmeasured, with no token or session figure.
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
 * Sort key: the total tokens that node consumes.
 * The product's question is "what do I turn off and how much is left", so servers and tools are
 * ordered by this value descending, not by order of appearance, keeping the expensive items on top.
 * It uses the same unit rules as costSegment (upfront = accumulated calls + per-session definitions).
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

/** Descending by cost, ties broken by name ascending: identical data must land in identical places so the eye can follow. */
function byCostDesc<T>(weight: (item: T) => number, name: (item: T) => string) {
  return (a: T, b: T): number => weight(b) - weight(a) || name(a).localeCompare(name(b));
}

/** Summation fold of the accumulated cost, shared by server and client nodes.
 * definitionMeasured is an AND: to keep the displayed value a measured lower bound, one unmeasured
 * child must mark the whole as unmeasured, which avoids overconfidence. */
function sumCosts(costs: CumulativeCost[]): CumulativeCost {
  return costs.reduce(
    (acc, c) => ({ tokens: acc.tokens + c.tokens,
      definitionMeasured: acc.definitionMeasured && c.definitionMeasured }),
    { tokens: 0, definitionMeasured: true },
  );
}

/**
 * Definition tokens measured by the scan. Even with no usage history, this value is already measured.
 *
 * Measured regression: a first-time user who has not installed hooks yet has zero usage records right
 * after a scan, and this path used to carry only the server name with a hardcoded "0 calls · 0 tokens",
 * throwing away the definition tokens just measured. A tool that scans and then shows 0 has no reason to exist.
 *
 * With no session records we cannot tell upfront from deferred loading, so no "/session" suffix is
 * added. It states only what was measured and defers any per-session claim until usage records exist.
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

/** A managed server with no usage history becomes a zero-call server node (spec 1-2: configured servers are always shown) */
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
  // Servers Lens does not support (DCR refusal and friends) appear nowhere in the tree.
  managedServers = managedServers.filter((s) => !excludeServers.has(s.name));
  const managed = new Map(managedServers.map((s) => [s.name, s]));
  const analysisByTool = new Map(analysisRows.map((row) => [`${row.serverName}\u0000${row.toolName}`, row]));
  const roots: LensNode[] = splitByClient(input).map(({ client, input: sub }) => {
    // Mode-aware display: on a deferred-loading client, unused tools with zero real cost are hidden
    const rows = visibleMatrixRows(buildMatrix(sub), sub.sessions)
      .filter((r) => !excludeServers.has(r.serverName));
    const callSessions = callSessionCounts(sub.calls);
    // Upfront separates calls (accumulated) from definitions (per session); deferred loading shows one accumulated value.
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
          // With the server off, per-tool toggles are meaningless, so the menu is hidden (enabled is not set)
          const enabled = client === 'claude-code' && serverEnabled !== false
            ? !deniedRules.has(mcpDenyRule(server, r.toolName)) : undefined;
          // The recommendation (keep, remove, inspect, filter-server) is never written out. The icon
          // carries the verdict (check, trash, warning, filter in lensTreeProvider). Repeating the same
          // word on every tool pushes aside the numbers that matter, and one word cannot explain why.
          // Low confidence suppresses the icon itself, so a "(candidate)" marker is unnecessary too.
          // The basis lives in the analysis details opened by clicking the row, and in the report.
          const { action, confidence } = r.recommendation;
          const toolDesc = `${fmtCalls(r.callCount, r.reliability.errorCount)} · ${costSegment([r], callSessions, perSession, true)}`;
          const analysis = analysisByTool.get(`${server}\u0000${r.toolName}`);
          // The summary sentence is not carried on the row. It often repeats what status says at greater
          // ("Independent" · "Tool a operates independently without being used by other tools."),
          // length, and it is the longest piece on the line, pushing the numbers next to it off screen.
          // The summary is intact in the analysis details opened by clicking the row (openAnalysisDetails).
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
    // Fold directly over all rows, matching the child (server) sum even on a collapsed tree, so no false 0tok
    return {
      kind: 'client' as const, id: client, label: client,
      description:
        `${sub.sessions.length} sessions · total ${fmtCalls(totalCalls, totalErrors)} · ${costSegment(rows, callSessions, perSession, false)}${wasteSuffix(rows)}`,
      children: servers,
    };
  });
  // Configured servers are shown even with no claude-code session in the period (spec 1-2)
  if (managedServers.length > 0 && !roots.some((r) => r.id === 'claude-code')) {
    const servers = zeroUsageServerNodes(managedServers, new Set(), input.definitions);
    const allTools = managedServers.flatMap((s) => definedTools(input.definitions, s.name));
    roots.push({
      kind: 'client', id: 'claude-code', label: 'claude-code',
      description: `0 sessions · total 0 calls · ${definitionSegment(allTools)}`,
      children: servers,
    });
  }
  // Before a scan the tree is a row of zeros that never says what to do next. The viewsWelcome in
  // package.json appears only when the tree is completely empty, and with even one configured server
  // a "0 calls · 0 tokens" row exists, so it never appears. This hint row fills that gap.
  // It is appended last. Inserting it earlier would break the existing contract that the first row is
  // a client, and before a scan the tree is short enough that last still fits on one screen.
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
