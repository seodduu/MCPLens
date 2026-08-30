// packages/core/src/report/rollup.ts
// EngineInput -> ReportModel aggregation (Task 35). No new verdict logic: action/confidence are
// read as engine.ts already produced them, and only bucketing, grouping and sorting happen here.
// Design: docs/designs/2026-07-20-리포트-가독성-설계.md §4-2/§4-3/§4-4/§5.
import type { ClientId, MatrixRow, ServerContextOverhead, ServerVerdict, SessionMeta } from '../types.js';
import { incompleteScans, type IncompleteScan } from './incompleteScans.js';
import { buildMatrix, splitByClient, visibleMatrixRows, type EngineInput } from '../engine/engine.js';
import { buildServerVerdicts } from '../engine/serverVerdict.js';
import { attributedSaving, instructionsTokensByServer, savingScope } from '../engine/cost.js';
import type {
  ClientReport, ReportBucket, ReportGroup, ReportModel, ReportOptions, ReportTool, ReportTotals,
} from './model.js';

/** Aggregation result for one client: the ClientReport to render plus the totals to sum globally. */
export interface ClientRollup {
  report: ClientReport;
  totals: ReportTotals;
  /**
   * Names of this client's servers that were left out of `totals` because of an identity conflict.
   * Optional so existing hand-written ClientRollup fixtures (predating this field) still type-check;
   * treated as empty when absent.
   */
  excludedServers?: ReadonlySet<string>;
}

/**
 * Public surface. A thin adapter that splits `EngineInput` per client, builds the matrix with
 * `buildMatrix`, and delegates to the pure `rollupClient`/`assembleModel`.
 */
export function buildReport(input: EngineInput, opts: ReportOptions): ReportModel {
  const splits = splitByClient(input);
  const rollups = splits.map(({ client, input: sub }) => {
    const all = buildMatrix(sub);
    return rollupClient(client, sub.sessions, all, opts.conflictedServers, sub.serverOverheads);
  });
  // Server-level evidence, computed on the whole input rather than per client: only the servers
  // with nothing to keep them are carried, since 'keep' verdicts say nothing the tool rows do not.
  const serverVerdicts = buildServerVerdicts(input).filter((v) => v.action === 'remove-server');
  return assembleModel(rollups, opts, incompleteScans(input.scanStatuses), serverVerdicts);
}

const ZERO_TOTALS: ReportTotals = {
  actPerSessionTokens: 0,
  candidatePerSessionTokens: 0,
  actSavingTokens: 0,
  candidateSavingTokens: 0,
  actServerCount: 0,
  actToolCount: 0,
  candidateServerCount: 0,
  candidateToolCount: 0,
  inspectToolCount: 0,
  inspectWastedTokens: 0,
  healthyToolCount: 0,
  healthyResponseTokens: 0,
};

/** Sorts and sums the per-client rollups into the final ReportModel. Pure and exported so tests can call it directly. */
export function assembleModel(
  rollups: ClientRollup[], opts: ReportOptions, incompleteServers: IncompleteScan[] = [],
  serverVerdicts: ServerVerdict[] = [],
): ReportModel {
  const clients = rollups.map((r) => r.report).sort(compareClients);
  const totals = rollups.reduce((acc, r) => addTotals(acc, r.totals), { ...ZERO_TOTALS });
  const conflictedServers = [...new Set(rollups.flatMap((r) => [...(r.excludedServers ?? [])]))].sort();
  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    days: opts.days,
    clients,
    totals,
    incompleteServers,
    conflictedServers,
    serverVerdicts,
  };
}

function addTotals(a: ReportTotals, b: ReportTotals): ReportTotals {
  return {
    actPerSessionTokens: a.actPerSessionTokens + b.actPerSessionTokens,
    candidatePerSessionTokens: a.candidatePerSessionTokens + b.candidatePerSessionTokens,
    actSavingTokens: a.actSavingTokens + b.actSavingTokens,
    candidateSavingTokens: a.candidateSavingTokens + b.candidateSavingTokens,
    actServerCount: a.actServerCount + b.actServerCount,
    actToolCount: a.actToolCount + b.actToolCount,
    candidateServerCount: a.candidateServerCount + b.candidateServerCount,
    candidateToolCount: a.candidateToolCount + b.candidateToolCount,
    inspectToolCount: a.inspectToolCount + b.inspectToolCount,
    inspectWastedTokens: a.inspectWastedTokens + b.inspectWastedTokens,
    healthyToolCount: a.healthyToolCount + b.healthyToolCount,
    healthyResponseTokens: a.healthyResponseTokens + b.healthyResponseTokens,
  };
}

/** collapsed===false first, then descending by sessionCount (design §4-4). */
function compareClients(a: ClientReport, b: ClientReport): number {
  if (a.collapsed !== b.collapsed) return a.collapsed ? 1 : -1;
  return b.sessionCount - a.sessionCount;
}

/**
 * One client's MatrixRow[] -> ClientReport + totals. Pure and exported so tests can pass
 * hand-written MatrixRow[]/SessionMeta[] directly (no dependency on buildMatrix).
 */
export function rollupClient(
  client: ClientId,
  sessions: SessionMeta[],
  rows: MatrixRow[],
  conflictedServers: ReadonlySet<string> = new Set(),
  serverOverheads: readonly ServerContextOverhead[] = [],
): ClientRollup {
  // Attribution context (plan section 3.5). The tool count comes from every row of the server,
  // not just the visible ones: a group only removes the server when it accounts for all of them.
  const attribution: AttributionContext = {
    instructionsTokens: instructionsTokensByServer(serverOverheads),
    toolCountByServer: countToolsByServer(rows),
  };
  const visible = visibleMatrixRows(rows, sessions);
  const hiddenToolCount = rows.length - visible.length;
  const unmeasuredToolCount = visible.filter((r) => r.recommendation.action === 'unknown').length;
  const unobservedToolCount = visible.filter((r) => r.recommendation.action === 'unobserved').length;
  // 'unobserved' rows carry no evidence either way, so they are counted and then left out of the
  // buckets and the totals, exactly like 'unknown'.
  const bucketable = visible.filter(
    (r) => r.recommendation.action !== 'unknown' && r.recommendation.action !== 'unobserved');

  const rowsByBucket: Record<ReportBucket, MatrixRow[]> = { act: [], candidate: [], inspect: [], healthy: [] };
  for (const row of bucketable) {
    const bucket = assignBucket(row);
    if (bucket) rowsByBucket[bucket].push(row);
  }

  const buckets: Record<ReportBucket, ReportGroup[]> = {
    act: groupRows(rowsByBucket.act, attribution),
    candidate: groupRows(rowsByBucket.candidate, attribution),
    inspect: groupRows(rowsByBucket.inspect, attribution),
    healthy: groupRows(rowsByBucket.healthy, attribution),
  };

  const collapsed = buckets.act.length === 0 && buckets.inspect.length === 0 && buckets.candidate.length > 0;
  const collapsedSummary = collapsed
    ? {
        toolCount: rowsByBucket.candidate.length,
        perSessionTokens: sumDefinitionTokens(rowsByBucket.candidate),
      }
    : null;

  const report: ClientReport = {
    client,
    sessionCount: sessions.length,
    collapsed,
    buckets,
    collapsedSummary,
    hiddenToolCount,
    unmeasuredToolCount,
    unobservedToolCount,
  };

  // A conflicted server's row stays in the buckets/groups above (so the tool list still shows it),
  // but it is left out of the waste totals: only one client's copy of the name was actually scanned,
  // so this figure is not evidence about this client's server.
  const isConflicted = (row: MatrixRow) => conflictedServers.has(row.serverName);
  const actRowsForTotals = rowsByBucket.act.filter((r) => !isConflicted(r));
  const candidateRowsForTotals = rowsByBucket.candidate.filter((r) => !isConflicted(r));

  const excludedServers = new Set<string>();
  for (const r of rowsByBucket.act) if (isConflicted(r)) excludedServers.add(r.serverName);
  for (const r of rowsByBucket.candidate) if (isConflicted(r)) excludedServers.add(r.serverName);

  // The server counts are excluded on the same basis as the tool counts. Counting the servers but
  // not their tools would print "2 servers, 0 tools", a line that reads as a bug rather than as an exclusion.
  const actGroupsForTotals = buckets.act.filter((g) => !conflictedServers.has(g.serverName));
  const candidateGroupsForTotals = buckets.candidate.filter((g) => !conflictedServers.has(g.serverName));

  const totals: ReportTotals = {
    actPerSessionTokens: sumDefinitionTokens(actRowsForTotals),
    candidatePerSessionTokens: sumDefinitionTokens(candidateRowsForTotals),
    // Summed over groups, not rows: the instructions overhead belongs to the server, and only the
    // group that removes the whole server may claim it. One server yields at most one such group,
    // so no overhead is counted twice.
    actSavingTokens: sumSavingTokens(actGroupsForTotals),
    candidateSavingTokens: sumSavingTokens(candidateGroupsForTotals),
    actServerCount: actGroupsForTotals.length,
    actToolCount: actRowsForTotals.length,
    candidateServerCount: candidateGroupsForTotals.length,
    candidateToolCount: candidateRowsForTotals.length,
    inspectToolCount: rowsByBucket.inspect.length,
    inspectWastedTokens: rowsByBucket.inspect.reduce((s, r) => s + r.reliability.failedResponseTokens, 0),
    healthyToolCount: rowsByBucket.healthy.length,
    healthyResponseTokens: rowsByBucket.healthy.reduce((s, r) => s + r.responseTokens, 0),
  };

  return { report, totals, excludedServers };
}

/** Bucket assignment (design §4-3). action='unknown' is already filtered out by the caller. */
function assignBucket(row: MatrixRow): ReportBucket | null {
  const { action, confidence } = row.recommendation;
  // Never loaded under deferred loading: no bucket, no total. It is a footnote, not an action.
  if (action === 'unobserved') return null;
  if (action === 'remove' || action === 'filter-server') {
    return confidence === 'low' ? 'candidate' : 'act';
  }
  if (action === 'inspect') return 'inspect';
  if (action === 'keep') return 'healthy';
  return null;
}

function sumDefinitionTokens(rows: MatrixRow[]): number {
  return rows.reduce((s, r) => s + (r.definitionTokens ?? 0), 0);
}

function sumSavingTokens(groups: ReportGroup[]): number {
  return groups.reduce((s, g) => s + g.savingTokens, 0);
}

/** What buildGroup needs to attribute the per-server instructions overhead. */
interface AttributionContext {
  instructionsTokens: ReadonlyMap<string, number>;
  toolCountByServer: ReadonlyMap<string, number>;
}

function countToolsByServer(rows: MatrixRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.serverName, (counts.get(r.serverName) ?? 0) + 1);
  return counts;
}

/** Groups by (serverName, action, confidence) and sorts descending by perSessionTokens. */
function groupRows(rows: MatrixRow[], attribution: AttributionContext): ReportGroup[] {
  const map = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const key = `${row.serverName}\0${row.recommendation.action}\0${row.recommendation.confidence}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return [...map.values()]
    .map((rowsForKey) => buildGroup(rowsForKey, attribution))
    .sort((a, b) => b.perSessionTokens - a.perSessionTokens);
}

function buildGroup(rowsForKey: MatrixRow[], attribution: AttributionContext): ReportGroup {
  const first = rowsForKey[0];
  const tools = rowsForKey.map(toReportTool).sort((a, b) => (b.perSessionTokens ?? 0) - (a.perSessionTokens ?? 0));
  const perSessionTokens = sumDefinitionTokens(rowsForKey);
  const instructionsTokens = attribution.instructionsTokens.get(first.serverName) ?? 0;
  const coversEveryTool =
    rowsForKey.length === (attribution.toolCountByServer.get(first.serverName) ?? rowsForKey.length);
  const action = first.recommendation.action;
  const scope = savingScope(action, coversEveryTool);
  const savingTokens = attributedSaving(perSessionTokens, instructionsTokens, scope);
  // Only a group the user could act on can "leave instructions behind". A keep/inspect group is
  // not a saving proposal, so it reports no retained overhead rather than a number to compare.
  const proposesSaving = action === 'remove' || action === 'filter-server';
  return {
    serverName: first.serverName,
    action: first.recommendation.action,
    confidence: first.recommendation.confidence,
    headline: first.recommendation.reasonParts.serverBasis ?? null,
    caveat: modeOf(rowsForKey.map((r) => r.recommendation.reasonParts.caveat)),
    perSessionTokens,
    instructionsTokens,
    savingTokens,
    retainedInstructionsTokens: proposesSaving && scope === 'tool-filter' ? instructionsTokens : 0,
    totalObservedCost: rowsForKey.reduce((s, r) => s + (r.recommendation.evidence.totalObservedCost ?? 0), 0),
    hasUnmeasured: rowsForKey.some((r) => r.definitionTokens == null),
    tools,
  };
}

function toReportTool(row: MatrixRow): ReportTool {
  const basis = row.recommendation.reasonParts.basis;
  return {
    toolName: row.toolName,
    perSessionTokens: row.definitionTokens,
    totalObservedCost: row.recommendation.evidence.totalObservedCost,
    callCount: row.callCount,
    errorCount: row.reliability.errorCount,
    errorRate: row.reliability.errorRate,
    responseTokens: row.responseTokens,
    lastCalledAt: row.recommendation.evidence.lastCalledAt,
    note: basis === '' ? null : basis,
  };
}

/** Most common value. Ties go to whichever appeared first. */
function modeOf(values: Array<string | null>): string | null {
  const order: Array<string | null> = [];
  const counts = new Map<string | null, number>();
  for (const v of values) {
    if (!counts.has(v)) order.push(v);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = order.length > 0 ? order[0] : null;
  let bestCount = -1;
  for (const v of order) {
    const c = counts.get(v)!;
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
}
