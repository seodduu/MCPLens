// packages/core/src/report/model.ts
// Data model of the action-first report. The contract between aggregation (rollup) and
// rendering (markdown). Design: docs/designs/2026-07-20-리포트-가독성-설계.md
import type { ClientId, Recommendation, RecommendationConfidence } from '../types.js';

/**
 * Action bucket: the primary sort key of the report. Rows are ordered by
 * "what should the user do now", not by "how big is the definition".
 */
export type ReportBucket = 'act' | 'candidate' | 'inspect' | 'healthy';

export interface ReportTool {
  toolName: string;
  /** = definitionTokens. null when the scanner does not cover this tool. */
  perSessionTokens: number | null;
  totalObservedCost: number | null;
  callCount: number;
  errorCount: number;
  errorRate: number | null;
  responseTokens: number;
  lastCalledAt: string | null;
  /** Caveat specific to this tool (not the server-wide one). null when absent. */
  note: string | null;
}

/**
 * Tools sharing a server, an action and a confidence: one unit of action for the user.
 * The shared server basis (headline) and the confidence caveat live here once and are never
 * repeated on the tool rows.
 */
export interface ReportGroup {
  serverName: string;
  action: Recommendation['action'];
  confidence: RecommendationConfidence;
  /** Shared server basis (reasonParts.serverBasis). null for a single-tool group. */
  headline: string | null;
  /** Representative caveat of the group (the most common reasonParts.caveat). */
  caveat: string | null;
  /** Sum of perSessionTokens in the group (null counts as 0). */
  perSessionTokens: number;
  totalObservedCost: number;
  /** Whether any tool has a null perSessionTokens; the renderer shows "partly unmeasured". */
  hasUnmeasured: boolean;
  /** Descending by perSessionTokens. */
  tools: ReportTool[];
}

export interface ClientReport {
  client: ClientId;
  sessionCount: number;
  /**
   * Whether the whole client was collapsed for lack of observation.
   * act and inspect empty with only candidates left means "no confirmed action, just a pile of
   * candidates". This is where the least trustworthy section is stopped from being the longest
   * one (design §1 P6).
   */
  collapsed: boolean;
  buckets: Record<ReportBucket, ReportGroup[]>;
  /** Meaningful only when collapsed: summary of the folded-away unused definitions. */
  collapsedSummary: { toolCount: number; perSessionTokens: number } | null;
  /** Number of zero-real-cost tools hidden by visibleMatrixRows. */
  hiddenToolCount: number;
  /** Number of action='unknown' tools (definition tokens unavailable); shown only as a footnote. */
  unmeasuredToolCount: number;
}

export interface ReportTotals {
  actPerSessionTokens: number;
  candidatePerSessionTokens: number;
  actServerCount: number;
  actToolCount: number;
  candidateServerCount: number;
  candidateToolCount: number;
  inspectToolCount: number;
  inspectWastedTokens: number;
  healthyToolCount: number;
  healthyResponseTokens: number;
}

export interface ReportModel {
  generatedAt: string;
  days: number;
  /** collapsed=false first, then descending by sessionCount. */
  clients: ClientReport[];
  totals: ReportTotals;
}

export interface ReportOptions {
  /** 'summary' truncates candidate and healthy tool lists to 5. act and inspect are never truncated. */
  detail: 'summary' | 'full';
  /** The "last N days" in the headline. */
  days: number;
  /** Generation timestamp (ISO), injected so tests stay deterministic. */
  now?: string;
}

/** Maximum tools shown per group in summary mode. */
export const SUMMARY_TOOL_LIMIT = 5;

/** Buckets that are never truncated: action and inspection targets are always shown in full. */
export const NEVER_TRUNCATED: readonly ReportBucket[] = ['act', 'inspect'];
