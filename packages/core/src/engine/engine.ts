// packages/core/src/engine/engine.ts
import type { ServerScanStatus } from '../store/store.js';
import type { ClientId, LoadPattern, MatrixRow, Recommendation, RecommendationReason,
  ServerContextOverhead, SessionMeta, ToolCallEvent, ToolDefinition,
  ToolLoadEvent } from '../types.js';
import { buildEvidenceContext, confidenceCaveat, EMPTY_EVIDENCE, inspectConfidence,
  removeConfidence, toolEvidence, type EvidenceContext } from './evidence.js';
import { formatTokens } from './format.js';

export interface EngineInput {
  definitions: ToolDefinition[];
  calls: ToolCallEvent[];
  loads: ToolLoadEvent[];
  sessions: SessionMeta[];
  /**
   * "server tool" -> all-time last call timestamp (store.lastCallByTool()).
   * Optional. Without it the verdict uses only calls inside the analysis window, and past use
   * outside the window is invisible.
   */
  lastCallByTool?: Map<string, string>;
  /**
   * client -> the set of server names configured for that client (store.serversByClient()).
   * Optional. Without it definitions are not filtered (legacy behaviour), which is safe even on
   * a DB that has never been scanned.
   */
  serversByClient?: Map<ClientId, Set<string>>;
  /**
   * Per-server `instructions` overhead (store.allServerContextOverheads()).
   * Optional: a DB scanned before the v2 estimator has none, and then every server's overhead is
   * 0, which is the pre-existing behaviour. Only the saving attribution (plan section 3.5) reads
   * it; no tool row owns these tokens, so the matrix does not change.
   */
  serverOverheads?: ServerContextOverhead[];
  /**
   * server -> last scan status (store.serverScanStatuses()).
   * Optional. Nothing in the matrix reads it: a failed scan changes what the report can *claim*,
   * not what was observed. Report surfaces read it to say which servers are only partly accounted
   * for, instead of presenting a call-history-only row count as the whole tool list.
   */
  scanStatuses?: ReadonlyMap<string, ServerScanStatus>;
}

// Verdict thresholds (design doc ch. 7, feature 1 revision)
const INSPECT_MIN_CALLS = 3;
const INSPECT_ERROR_RATE = 0.5;
const ALWAYS_LOAD_SESSION_RATIO = 0.5;

export function buildMatrix(input: EngineInput): MatrixRow[] {
  const { definitions, calls, loads, sessions } = input;
  const key = (s: string, t: string) => `${s} ${t}`;

  const callAgg = new Map<string, { n: number; tokens: number; errN: number; errTokens: number }>();
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    const a = callAgg.get(k) ?? { n: 0, tokens: 0, errN: 0, errTokens: 0 };
    a.n++; a.tokens += c.responseTokens ?? 0;
    if (c.isError) { a.errN++; a.errTokens += c.responseTokens ?? 0; }
    callAgg.set(k, a);
  }
  const loadSessions = new Map<string, Set<string>>();
  for (const l of loads) {
    const k = key(l.serverName ?? '', l.toolName);
    (loadSessions.get(k) ?? loadSessions.set(k, new Set()).get(k)!).add(l.sessionId);
  }

  // Per-server usage ratio (for the filter-server verdict)
  const byServer = new Map<string, { total: number; used: number }>();
  for (const d of definitions) {
    const s = byServer.get(d.serverName) ?? { total: 0, used: 0 };
    s.total++;
    if ((callAgg.get(key(d.serverName, d.toolName))?.n ?? 0) > 0) s.used++;
    byServer.set(d.serverName, s);
  }

  const dominantMode = pickDominantMode(sessions);
  const evidenceCtx = buildEvidenceContext(
    definitions, calls, loads, sessions, input.lastCallByTool);

  // Union of defined tools, call-only tools and load-only tools (M4).
  // Dropping load-only tools would hide "loaded but never called" (search-space pollution).
  const rows = new Map<string, MatrixRow>();
  for (const d of definitions) rows.set(key(d.serverName, d.toolName), baseRow(d.serverName, d.toolName, d.definitionTokens));
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    if (!rows.has(k)) rows.set(k, baseRow(c.serverName, c.toolName, null));
  }
  for (const l of loads) {
    if (l.serverName == null) continue; // loads with no server attribution (code-mode search aggregates) get no row
    const k = key(l.serverName, l.toolName);
    if (!rows.has(k)) rows.set(k, baseRow(l.serverName, l.toolName, null));
  }

  for (const [k, row] of rows) {
    const a = callAgg.get(k);
    row.callCount = a?.n ?? 0;
    row.responseTokens = a?.tokens ?? 0;
    row.loadedSessionCount = loadSessions.get(k)?.size ?? 0;
    row.sessionCount = sessions.length;
    row.reliability = {
      errorCount: a?.errN ?? 0,
      errorRate: a && a.n > 0 ? a.errN / a.n : null,
      failedResponseTokens: a?.errTokens ?? 0,
    };
    row.loadPattern = pickLoadPattern(row);
    row.recommendation = recommend(row, byServer.get(row.serverName), dominantMode, evidenceCtx);
  }
  return [...rows.values()].sort(
    (x, y) => (y.definitionTokens ?? 0) - (x.definitionTokens ?? 0));
}

export function sessionSavings(input: EngineInput) {
  const potentialTokens = input.definitions.reduce((s, d) => s + d.definitionTokens, 0);
  const defTokens = new Map(input.definitions.map(
    (d) => [`${d.serverName} ${d.toolName}`, d.definitionTokens]));
  // Pick per key (server/tool): the directly recorded loadedTokens when present, else the value
  // joined from the definition. Loads from servers with no definition (not covered by a scan) are
  // outside the comparison set and excluded, keeping the set identical to potentialTokens.
  const perKey = new Map<string, number>();
  for (const l of input.loads) {
    const k = `${l.serverName ?? ''} ${l.toolName}`;
    if (!defTokens.has(k)) continue;
    const joined = defTokens.get(k)!;
    const v = l.loadedTokens != null && l.loadedTokens > 0 ? l.loadedTokens : joined;
    const prev = perKey.get(k);
    if (prev === undefined || v > prev) perKey.set(k, v);
  }
  let actualTokens = 0;
  for (const v of perKey.values()) actualTokens += v;
  return { potentialTokens, actualTokens,
    savedTokens: Math.max(0, potentialTokens - actualTokens) };
}

function baseRow(serverName: string, toolName: string, definitionTokens: number | null): MatrixRow {
  const reasonParts: RecommendationReason = { basis: '', serverBasis: null, effect: null, caveat: null };
  return { serverName, toolName, definitionTokens, callCount: 0, responseTokens: 0,
    loadedSessionCount: 0, sessionCount: 0,
    recommendation: { action: 'unknown', confidence: 'low', reason: joinReason(reasonParts),
      reasonParts, evidenceLabel: 'not measurable', evidence: EMPTY_EVIDENCE },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null };
}

function pickLoadPattern(row: MatrixRow): LoadPattern {
  if (row.loadedSessionCount === 0) return null;
  if (row.callCount === 0) return 'search-pollution';
  if (row.sessionCount > 0 && row.loadedSessionCount / row.sessionCount >= ALWAYS_LOAD_SESSION_RATIO)
    return 'always-load-candidate';
  return null;
}

/**
 * Dominant accounting mode across sessions. DEFERRED_OPAQUE means "no MCP evidence", not
 * evidence of a mode, so it is excluded from the majority vote: the result is OPAQUE only when
 * no session carries evidence at all.
 */
export function dominantMode(sessions: SessionMeta[]): SessionMeta['mode'] {
  const counts = new Map<SessionMeta['mode'], number>();
  for (const s of sessions) {
    if (s.mode === 'DEFERRED_OPAQUE') continue;
    counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
  }
  let best: SessionMeta['mode'] = 'DEFERRED_OPAQUE', n = 0;
  for (const [m, c] of counts) if (c > n) { best = m; n = c; }
  return best;
}

/**
 * Mode-aware display filter (the display layer of design 4-2).
 * Deferred loading: tools with 0 calls and 0 loads cost nothing, so they are hidden
 * (search-pollution rows stay, since their loads do cost).
 * Upfront: an unused definition still costs every session, so everything is shown.
 * The DB records all of it; this filter is display-only.
 */
export function visibleMatrixRows(rows: MatrixRow[], sessions: SessionMeta[]): MatrixRow[] {
  if (dominantMode(sessions) === 'UPFRONT') return rows;
  return rows.filter((r) => r.callCount > 0 || r.loadedSessionCount > 0);
}

function pickDominantMode(sessions: SessionMeta[]): SessionMeta['mode'] {
  return dominantMode(sessions);
}

function recommend(
  row: MatrixRow,
  server: { total: number; used: number } | undefined,
  mode: SessionMeta['mode'],
  ctx: EvidenceContext,
): Recommendation {
  const evidence = toolEvidence(row.serverName, row.toolName, row.definitionTokens, ctx);
  const evidenceLabel =
    mode === 'DEFERRED_MEASURABLE' ? 'measured' :
    mode === 'DEFERRED_ESTIMATED' ? 'lower-bound estimate' :
    mode === 'UPFRONT' ? 'assumed full load' : 'not measurable';
  const sizePhrase = (t: number) =>
    mode === 'UPFRONT'
      ? `about ${formatTokens(t)} tokens saved per session when removed`
      : `small savings, but cleans up the search space`;

  const pollutionSuffix = row.loadPattern === 'search-pollution'
    ? ' (loaded but never called, so it pollutes the search space)' : '';

  if (row.callCount === 0 && row.definitionTokens != null) {
    // Low confidence never demotes the verdict; the surface renders it as a "candidate" (spec decision 2)
    const confidence = removeConfidence(evidence);
    const caveat = confidenceCaveat(confidence, evidence);
    if (server && server.total >= 10 && server.used > 0 && server.used / server.total < 0.2) {
      const reasonParts: RecommendationReason = {
        basis: '',
        serverBasis: `Only ${server.used} of ${server.total} tools used on server ${row.serverName}. Tool filtering recommended.`,
        effect: `${sizePhrase(row.definitionTokens)}${pollutionSuffix}`,
        caveat,
      };
      return { action: 'filter-server', confidence, reason: joinReason(reasonParts), reasonParts,
        evidenceLabel, evidence };
    }
    const reasonParts: RecommendationReason = {
      basis: `definition ${formatTokens(row.definitionTokens)} tokens, 0 calls`,
      serverBasis: null,
      effect: `${sizePhrase(row.definitionTokens)}${pollutionSuffix}`,
      caveat,
    };
    return { action: 'remove', confidence, reason: joinReason(reasonParts), reasonParts,
      evidenceLabel, evidence };
  }
  if (
    row.callCount >= INSPECT_MIN_CALLS &&
    row.reliability.errorRate != null &&
    row.reliability.errorRate >= INSPECT_ERROR_RATE
  ) {
    const rate = Math.round(row.reliability.errorRate * 100);
    const reasonParts: RecommendationReason = {
      basis: `${row.reliability.errorCount} of ${row.callCount} calls failed (${rate}%), `
        + `${formatTokens(row.reliability.failedResponseTokens)} tokens wasted on failed responses`,
      serverBasis: null, effect: 'inspect or replace', caveat: null,
    };
    return { action: 'inspect', confidence: inspectConfidence(row.callCount),
      reason: joinReason(reasonParts), reasonParts, evidenceLabel, evidence };
  }
  // Called at all is self-evident, so confidence is pinned high
  if (row.callCount > 0) {
    const reasonParts: RecommendationReason = {
      basis: `called ${row.callCount} ${row.callCount === 1 ? 'time' : 'times'}`,
      serverBasis: null, effect: null, caveat: null };
    return { action: 'keep', confidence: 'high', reason: joinReason(reasonParts), reasonParts,
      evidenceLabel, evidence };
  }
  const reasonParts: RecommendationReason = {
    basis: 'definition tokens unavailable (not covered by the scanner)', serverBasis: null, effect: null, caveat: null };
  return { action: 'unknown', confidence: 'low', reason: joinReason(reasonParts), reasonParts,
    evidenceLabel: 'not measurable', evidence };
}

/** parts -> the reason string. The separator rule lives in this one place. */
export function joinReason(p: RecommendationReason): string {
  // The lead is serverBasis when present, otherwise basis.
  // Pieces are joined with a period, since joining with a dash makes the sentence feel broken.
  // If a piece already ends in a period, only one is kept.
  const lead = p.serverBasis ?? p.basis;
  return [lead, p.effect, p.caveat]
    .filter((part): part is string => part != null && part.trim() !== '')
    .map((part) => part.trim().replace(/\.+$/u, ''))
    .join('. ');
}

/**
 * Splits EngineInput per client (for the per-client matrix display).
 * definitions are a client-independent shared resource, so each split keeps them intact.
 * lastCallByTool is passed through for the same reason: call history from another client is
 * evidence of a "tool we used to use", so it can only lower confidence (high -> medium). That is
 * the conservative direction, so passing it through is correct. Withholding it would hide
 * "past use outside the window", turning the tool into an unused one and producing a false high.
 */
export function splitByClient(
  input: EngineInput,
): Array<{ client: ClientId; input: EngineInput }> {
  const clients = [...new Set(input.sessions.map((s) => s.client))].sort();
  return clients.map((client) => {
    const ids = new Set(
      input.sessions.filter((s) => s.client === client).map((s) => s.sessionId));
    // No serversByClient map at all, or a completely empty one (size 0), means no filtering
    // (absent/empty = no mapping information: before a scan, or mid-migration).
    // If the map has rows but not this client's key, that client has zero servers: treat as an empty Set.
    const allowed = input.serversByClient && input.serversByClient.size > 0
      ? (input.serversByClient.get(client) ?? new Set<string>())
      : undefined;
    return {
      client,
      input: {
        // No mapping lets everything through (legacy behaviour). With a mapping, only that
        // client's servers pass. Calls and loads are never filtered: real usage history of a
        // server deleted from the config must still be visible.
        definitions: allowed === undefined
          ? input.definitions
          : input.definitions.filter((d) => allowed.has(d.serverName)),
        calls: input.calls.filter((c) => ids.has(c.sessionId)),
        loads: input.loads.filter((l) => ids.has(l.sessionId)),
        sessions: input.sessions.filter((s) => s.client === client),
        lastCallByTool: input.lastCallByTool,
        serversByClient: input.serversByClient,
        // Server-scoped and client-independent, like definitions: passed through whole and looked
        // up by server name, so a client that does not use a server never reads its overhead.
        serverOverheads: input.serverOverheads,
      },
    };
  });
}
