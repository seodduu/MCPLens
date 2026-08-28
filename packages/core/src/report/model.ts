// packages/core/src/report/model.ts
// Data model of the action-first report. The contract between aggregation (rollup) and
// rendering (markdown). Design: docs/designs/2026-07-20-리포트-가독성-설계.md
import type { ClientId, Recommendation, RecommendationConfidence } from '../types.js';
import type { IncompleteScan } from './incompleteScans.js';

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
  /**
   * The server's `instructions` overhead, per session (0 when the server publishes none or was
   * never scanned by the v2 estimator). It belongs to no single tool.
   */
  instructionsTokens: number;
  /**
   * What acting on this group really saves per session: perSessionTokens, plus instructionsTokens
   * only when the group removes the whole server (plan section 3.5). Filtering tools, even all of
   * them, leaves the instructions loaded.
   */
  savingTokens: number;
  /**
   * The instructions tokens this group does NOT save. Non-zero exactly when filtering is chosen
   * over removal, and it is how much more removing the server would save.
   */
  retainedInstructionsTokens: number;
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
  /**
   * actPerSessionTokens plus the instructions overhead of the servers that are removed outright.
   * Greater than actPerSessionTokens only where a whole server goes away, which is what makes the
   * gap between "remove the server" and "filter its tools" visible in the totals.
   */
  actSavingTokens: number;
  /** Same rule as actSavingTokens, for the candidate bucket. */
  candidateSavingTokens: number;
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
  /**
   * Servers whose last scan did not complete (failed or authentication required). Their tool rows
   * come from call history alone, so their token totals are a lower bound. Empty when every
   * scanned server is ok, and also when the caller passed no scan statuses.
   */
  incompleteServers?: IncompleteScan[];
  /** Servers left out of the waste totals because of an identity conflict. Empty when there are none. */
  conflictedServers: string[];
}

export interface ReportOptions {
  /** 'summary' truncates candidate and healthy tool lists to 5. act and inspect are never truncated. */
  detail: 'summary' | 'full';
  /** The "last N days" in the headline. */
  days: number;
  /** Generation timestamp (ISO), injected so tests stay deterministic. */
  now?: string;
  /**
   * Names of servers whose identity conflicts across clients (two clients define the same name with a
   * different endpoint). Only one of them is actually scanned, so its token figure does not describe
   * the other client's server. Counting it as a saving would state a number that is not true, so these
   * servers are left out of the waste totals and reported separately instead of being dropped in silence.
   */
  conflictedServers?: ReadonlySet<string>;
}

/** Maximum tools shown per group in summary mode. */
export const SUMMARY_TOOL_LIMIT = 5;

/** Buckets that are never truncated: action and inspection targets are always shown in full. */
export const NEVER_TRUNCATED: readonly ReportBucket[] = ['act', 'inspect'];
