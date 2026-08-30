// packages/core/src/engine/evidence.ts
// Pure module that computes "how much have we observed" for a recommendation.
// engine.ts only assembles the result into a Recommendation.
import type { RecommendationConfidence, RecommendationEvidence, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';
import { formatTokens } from './format.js';

/** Minimum observation for high confidence. Also used in the "confirmed at N sessions" wording. */
export const HIGH_CONFIDENCE_SESSIONS = 10;
const HIGH_CONFIDENCE_DAYS = 7;
const LOW_CONFIDENCE_SESSIONS = 5;
const LOW_CONFIDENCE_DAYS = 3;
/** An inspect sample at or above this size is high confidence. */
const INSPECT_HIGH_CALLS = 10;
const MS_PER_DAY = 86_400_000;

export const EMPTY_EVIDENCE: RecommendationEvidence = {
  observedSessions: 0, datedObservedSessions: 0, windowSessions: 0, observedDays: null, lastCalledAt: null,
  costPerSession: null, totalObservedCost: null,
};

const key = (server: string, tool: string) => `${server} ${tool}`;

/** ISO string -> epoch ms. Unparsable and null both give null (string comparison breaks once offset notations mix). */
function ms(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export interface EvidenceContext {
  sessions: SessionMeta[];
  /** server name -> startedAt of the earliest session with activity (calls or loads) for that server */
  serverFirstActivity: Map<string, string>;
  /**
   * server name -> the minimum firstScannedAt across every defined tool of that server
   * (= when the server was first scanned). A tool whose firstScannedAt is later than this was
   * "added to an existing server later", so it must not inherit the server's older activity.
   */
  serverScanEpoch: Map<string, string>;
  /** Latest session startedAt in scope: the end of the window. */
  windowEnd: string | null;
  /** "server tool" -> last call timestamp inside the window */
  lastCallInScope: Map<string, string>;
  /** "server tool" -> all-time last call timestamp (including past use outside the window) */
  lastCallAllTime: Map<string, string>;
  /** "server tool" → firstScannedAt */
  firstScanned: Map<string, string>;
  /** "server tool" -> sessionIds holding a load event for that tool. */
  loadedSessions: Map<string, Set<string>>;
  /**
   * "server tool" -> startedAt of the earliest session with that tool's own activity.
   * Stands in for firstScannedAt on tools with no definition (load-only). Using server-level
   * activity instead would let a tool first loaded yesterday inherit an old server's entire
   * history and produce false confidence.
   */
  toolFirstActivity: Map<string, string>;
}

export function buildEvidenceContext(
  definitions: ToolDefinition[],
  calls: ToolCallEvent[],
  loads: ToolLoadEvent[],
  sessions: SessionMeta[],
  lastCallAllTime: Map<string, string> = new Map(),
): EvidenceContext {
  const startedAt = new Map(sessions.map((s) => [s.sessionId, s.startedAt]));

  // Even a pre-scan session with calls or loads for that server proves "the server was configured", so the window expands.
  const serverFirstActivity = new Map<string, string>();
  const toolFirstActivity = new Map<string, string>();
  const earliest = (map: Map<string, string>, k: string, at: string) => {
    const prev = map.get(k);
    if (prev === undefined || (ms(at) ?? Infinity) < (ms(prev) ?? Infinity)) map.set(k, at);
  };
  const noteActivity = (server: string | null, tool: string, sessionId: string) => {
    if (server == null) return;
    const at = startedAt.get(sessionId) ?? null;
    if (at == null) return;
    earliest(serverFirstActivity, server, at);
    earliest(toolFirstActivity, key(server, tool), at);
  };
  for (const c of calls) noteActivity(c.serverName, c.toolName, c.sessionId);
  const loadedSessions = new Map<string, Set<string>>();
  for (const l of loads) {
    noteActivity(l.serverName, l.toolName, l.sessionId);
    if (l.serverName == null) continue; // unjoined loads cannot be keyed to a tool
    const k = key(l.serverName, l.toolName);
    let set = loadedSessions.get(k);
    if (set === undefined) { set = new Set(); loadedSessions.set(k, set); }
    set.add(l.sessionId);
  }

  let windowEnd: string | null = null;
  for (const s of sessions) {
    const at = ms(s.startedAt);
    if (at == null) continue;
    if (windowEnd === null || at > (ms(windowEnd) ?? -Infinity)) windowEnd = s.startedAt;
  }

  const lastCallInScope = new Map<string, string>();
  for (const c of calls) {
    const at = ms(c.calledAt);
    if (at == null) continue;
    const k = key(c.serverName, c.toolName);
    const prev = lastCallInScope.get(k);
    if (prev === undefined || at > (ms(prev) ?? -Infinity)) lastCallInScope.set(k, c.calledAt!);
  }

  const firstScanned = new Map(
    definitions.map((d) => [key(d.serverName, d.toolName), d.firstScannedAt]));

  // First scan time per server = minimum firstScannedAt across that server's tools
  const serverScanEpoch = new Map<string, string>();
  for (const d of definitions) {
    const at = ms(d.firstScannedAt);
    if (at == null) continue;
    const prev = serverScanEpoch.get(d.serverName);
    if (prev === undefined || at < (ms(prev) ?? Infinity))
      serverScanEpoch.set(d.serverName, d.firstScannedAt);
  }

  return { sessions, serverFirstActivity, serverScanEpoch, windowEnd, lastCallInScope,
    lastCallAllTime, firstScanned, loadedSessions, toolFirstActivity };
}

export function toolEvidence(
  serverName: string,
  toolName: string,
  definitionTokens: number | null,
  ctx: EvidenceContext,
  mode: SessionMeta['mode'] = 'UPFRONT',
): RecommendationEvidence {
  const k = key(serverName, toolName);
  const toolFirstScanned = ms(ctx.firstScanned.get(k));
  const scanEpoch = ms(ctx.serverScanEpoch.get(serverName));
  const serverActivity = ms(ctx.serverFirstActivity.get(serverName));

  // Window start:
  //  - definition later than the server's first scan = a tool added to an existing server later.
  //    Observation of it exists only from that point, so the window is not expanded to server
  //    activity. (Expanding would turn a one-day-old tool into "47 sessions observed".)
  //  - definition equal to the server's first scan = the first scan. The adapter backfills past
  //    sessions, so widening the window to the server activity we really hold is correct.
  //  - no definition at all (load-only): the tool's own first activity stands in for
  //    firstScannedAt. Expanding to server activity would turn a tool first loaded yesterday on a
  //    three-week-old server into "21 sessions observed". (This path happens constantly with
  //    failed name joins and servers the scanner does not cover.)
  let windowStart: number | null;
  if (toolFirstScanned == null) {
    windowStart = ms(ctx.toolFirstActivity.get(k));
  } else if (scanEpoch != null && toolFirstScanned > scanEpoch) {
    windowStart = toolFirstScanned;
  } else {
    windowStart = serverActivity == null
      ? toolFirstScanned
      : Math.min(toolFirstScanned, serverActivity);
  }
  const windowEnd = ms(ctx.windowEnd);

  // With no lower bound for the window (no definition and no server-activity evidence), claim no
  // observation at all. Counting every session would inflate observedSessions and
  // totalObservedCost without grounds. The rule below that includes sessions with a null
  // startedAt does not apply here either: that rule prevents undercounting inside a valid window,
  // it is not grounds for inventing a window.
  let observedSessions = 0;
  // Counted separately: sessions with a valid startedAt confirmed to fall inside the window.
  // store.sessionsSince returns sessions with a null startedAt regardless of the window, so if
  // high confidence came from those alone, it would rest on "N sessions of unknown date".
  let datedObservedSessions = 0;
  // Every in-window session, counted before the mode gate: the sessions in which this tool
  // existed at all. Under deferred loading it is the divisor that turns "pulled in N times" into
  // a per-session figure (design 2026-08-31 3.2).
  let windowSessions = 0;
  if (windowStart != null) {
    const loaded = ctx.loadedSessions.get(k);
    for (const s of ctx.sessions) {
      const at = ms(s.startedAt);
      // A session without startedAt cannot be placed in the window, so it is included (prevents undercounting; a documented limitation)
      const inWindow = at == null
        || (at >= windowStart && (windowEnd == null || at <= windowEnd));
      if (!inWindow) continue;
      windowSessions++;
      // Mode gate: a session only observes this tool if its definition could have reached
      // the model. UPFRONT sends every definition each session. In deferred modes the definition
      // enters context only on a load event, so a session without one never saw the tool and must
      // not count toward "observed" (day-04 pilot: 36 never-loaded tools graded remove/medium off
      // 10 deferred sessions). DEFERRED_OPAQUE yields no MCP evidence at all, so it never counts
      // ("the lower side wins").
      if (s.mode !== 'UPFRONT') {
        if (s.mode === 'DEFERRED_OPAQUE') continue;
        if (loaded === undefined || !loaded.has(s.sessionId)) continue;
      }
      observedSessions++;
      if (at != null) datedObservedSessions++;
    }
  }

  // floor: an unfinished day must never bump the grade up ("the lower side wins")
  const observedDays =
    observedSessions === 0 || windowStart == null || windowEnd == null
      ? null
      : Math.max(0, Math.floor((windowEnd - windowStart) / MS_PER_DAY));

  // The later of the in-window call and the all-time history; without the all-time map it degrades naturally to the in-window value
  const inScope = ctx.lastCallInScope.get(k) ?? null;
  const allTime = ctx.lastCallAllTime.get(k) ?? null;
  const lastCalledAt =
    inScope == null ? allTime
    : allTime == null ? inScope
    : (ms(allTime) ?? 0) > (ms(inScope) ?? 0) ? allTime : inScope;

  // Under deferred loading the definition only enters context in the sessions that loaded it, so
  // the per-session charge is the definition amortised over the window. DEFERRED_OPAQUE is not
  // amortised: it carries no load evidence at all, so it keeps the upfront figure (it is
  // "not measurable" anyway).
  const deferred = mode === 'DEFERRED_MEASURABLE' || mode === 'DEFERRED_ESTIMATED';
  const costPerSession =
    definitionTokens == null ? null
    : !deferred ? definitionTokens
    : windowSessions === 0 ? null
    : Math.round(definitionTokens * observedSessions / windowSessions);
  return {
    observedSessions,
    datedObservedSessions,
    windowSessions,
    observedDays,
    lastCalledAt,
    costPerSession,
    // With no window lower bound the observation is unknown, so the accumulated cost is unknown
    // (null) too. Emitting 0 would read as "0 tokens of cost" in the UI and be indistinguishable
    // from EMPTY_EVIDENCE.
    totalObservedCost:
      definitionTokens == null || windowStart == null ? null : definitionTokens * observedSessions,
  };
}

/**
 * Confidence grade for remove / filter-server.
 * Where boundaries overlap the lower side wins, so the low conditions are checked first.
 */
export function removeConfidence(ev: RecommendationEvidence): RecommendationConfidence {
  if (ev.observedSessions < LOW_CONFIDENCE_SESSIONS) return 'low';
  if (ev.observedDays == null || ev.observedDays < LOW_CONFIDENCE_DAYS) return 'low';
  // high must clear the threshold on date-confirmed sessions alone: an observedSessions built up
  // from sessions of unknown date is not evidence of observation inside the window.
  if (ev.observedSessions >= HIGH_CONFIDENCE_SESSIONS
    && ev.datedObservedSessions >= HIGH_CONFIDENCE_SESSIONS
    && ev.observedDays >= HIGH_CONFIDENCE_DAYS
    && ev.lastCalledAt == null) return 'high';
  return 'medium';
}

/** inspect passes the existing gate (>=3 calls, >=50% failure rate) and is then graded on sample size alone. */
export function inspectConfidence(callCount: number): RecommendationConfidence {
  return callCount >= INSPECT_HIGH_CALLS ? 'high' : 'medium';
}

/** The body of the remove/filter-server confidence caveat (no separator). The report renderer uses this. */
export function confidenceCaveat(
  confidence: RecommendationConfidence,
  ev: RecommendationEvidence,
): string {
  const days = ev.observedDays == null ? '' : `/${ev.observedDays}d`;
  if (confidence === 'low')
    return `not enough observation (${ev.observedSessions} sessions${days}), `
      + `confirmed at ${HIGH_CONFIDENCE_SESSIONS} sessions. Not a confirmed recommendation yet`;
  if (confidence === 'medium' && ev.lastCalledAt != null)
    return `last called ${ev.lastCalledAt.slice(0, 10)}, may be a low-frequency tool. `
      + `Consider keeping it lazily loaded instead of deleting`;
  if (confidence === 'medium')
    return `${ev.observedSessions} sessions${days} observed, confirmed with more observation`;
  return `${ev.observedSessions} sessions${days} observed, `
    + `accumulated cost ${formatTokens(ev.totalObservedCost ?? 0)} tokens. Restorable with one config line`;
}

/** @deprecated The report renderer uses confidenceCaveat; this exists for reason-joining compatibility. */
export function confidencePhrase(
  confidence: RecommendationConfidence,
  ev: RecommendationEvidence,
): string {
  return `. ${confidenceCaveat(confidence, ev)}`;
}
