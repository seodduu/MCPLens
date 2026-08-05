// packages/core/src/report/rollup.ts
// EngineInput -> ReportModel aggregation (Task 35). No new verdict logic: action/confidence are
// read as engine.ts already produced them, and only bucketing, grouping and sorting happen here.
// Design: docs/designs/2026-07-20-리포트-가독성-설계.md §4-2/§4-3/§4-4/§5.
import type { ClientId, MatrixRow, SessionMeta } from '../types.js';
import { buildMatrix, splitByClient, visibleMatrixRows, type EngineInput } from '../engine/engine.js';
import type {
  ClientReport, ReportBucket, ReportGroup, ReportModel, ReportOptions, ReportTool, ReportTotals,
} from './model.js';

/** Aggregation result for one client: the ClientReport to render plus the totals to sum globally. */
export interface ClientRollup {
  report: ClientReport;
  totals: ReportTotals;
}

/**
 * Public surface. A thin adapter that splits `EngineInput` per client, builds the matrix with
 * `buildMatrix`, and delegates to the pure `rollupClient`/`assembleModel`.
 */
export function buildReport(input: EngineInput, opts: ReportOptions): ReportModel {
  const splits = splitByClient(input);
  const rollups = splits.map(({ client, input: sub }) => {
    const all = buildMatrix(sub);
    return rollupClient(client, sub.sessions, all);
  });
  return assembleModel(rollups, opts);
}

const ZERO_TOTALS: ReportTotals = {
  actPerSessionTokens: 0,
  candidatePerSessionTokens: 0,
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
export function assembleModel(rollups: ClientRollup[], opts: ReportOptions): ReportModel {
  const clients = rollups.map((r) => r.report).sort(compareClients);
  const totals = rollups.reduce((acc, r) => addTotals(acc, r.totals), { ...ZERO_TOTALS });
  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    days: opts.days,
    clients,
    totals,
  };
}

function addTotals(a: ReportTotals, b: ReportTotals): ReportTotals {
  return {
    actPerSessionTokens: a.actPerSessionTokens + b.actPerSessionTokens,
    candidatePerSessionTokens: a.candidatePerSessionTokens + b.candidatePerSessionTokens,
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
export function rollupClient(client: ClientId, sessions: SessionMeta[], rows: MatrixRow[]): ClientRollup {
  const visible = visibleMatrixRows(rows, sessions);
  const hiddenToolCount = rows.length - visible.length;
  const unmeasuredToolCount = visible.filter((r) => r.recommendation.action === 'unknown').length;
  const bucketable = visible.filter((r) => r.recommendation.action !== 'unknown');

  const rowsByBucket: Record<ReportBucket, MatrixRow[]> = { act: [], candidate: [], inspect: [], healthy: [] };
  for (const row of bucketable) {
    const bucket = assignBucket(row);
    if (bucket) rowsByBucket[bucket].push(row);
  }

  const buckets: Record<ReportBucket, ReportGroup[]> = {
    act: groupRows(rowsByBucket.act),
    candidate: groupRows(rowsByBucket.candidate),
    inspect: groupRows(rowsByBucket.inspect),
    healthy: groupRows(rowsByBucket.healthy),
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
  };

  const totals: ReportTotals = {
    actPerSessionTokens: sumGroupTokens(buckets.act),
    candidatePerSessionTokens: sumGroupTokens(buckets.candidate),
    actServerCount: buckets.act.length,
    actToolCount: rowsByBucket.act.length,
    candidateServerCount: buckets.candidate.length,
    candidateToolCount: rowsByBucket.candidate.length,
    inspectToolCount: rowsByBucket.inspect.length,
    inspectWastedTokens: rowsByBucket.inspect.reduce((s, r) => s + r.reliability.failedResponseTokens, 0),
    healthyToolCount: rowsByBucket.healthy.length,
    healthyResponseTokens: rowsByBucket.healthy.reduce((s, r) => s + r.responseTokens, 0),
  };

  return { report, totals };
}

/** Bucket assignment (design §4-3). action='unknown' is already filtered out by the caller. */
function assignBucket(row: MatrixRow): ReportBucket | null {
  const { action, confidence } = row.recommendation;
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

function sumGroupTokens(groups: ReportGroup[]): number {
  return groups.reduce((s, g) => s + g.perSessionTokens, 0);
}

/** Groups by (serverName, action, confidence) and sorts descending by perSessionTokens. */
function groupRows(rows: MatrixRow[]): ReportGroup[] {
  const map = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const key = `${row.serverName}\0${row.recommendation.action}\0${row.recommendation.confidence}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return [...map.values()].map(buildGroup).sort((a, b) => b.perSessionTokens - a.perSessionTokens);
}

function buildGroup(rowsForKey: MatrixRow[]): ReportGroup {
  const first = rowsForKey[0];
  const tools = rowsForKey.map(toReportTool).sort((a, b) => (b.perSessionTokens ?? 0) - (a.perSessionTokens ?? 0));
  return {
    serverName: first.serverName,
    action: first.recommendation.action,
    confidence: first.recommendation.confidence,
    headline: first.recommendation.reasonParts.serverBasis ?? null,
    caveat: modeOf(rowsForKey.map((r) => r.recommendation.reasonParts.caveat)),
    perSessionTokens: sumDefinitionTokens(rowsForKey),
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
