// packages/core/src/engine/serverVerdict.ts
// Server-level observation, counted on the server's own terms (design 2026-08-31 section 3.3).
// Tool evidence cannot say "this whole server is unused" under deferred loading: a session that
// never loaded a definition never observed the tool, so a wholly unloaded server collapses to
// "0 sessions observed". The server's name list, however, is in context every session, so the
// server verdict is entitled to count every configured session.
import { instructionsTokensByServer } from './cost.js';
import { dominantMode, type EngineInput } from './engine.js';
import { formatTokens } from './format.js';
import type { RecommendationConfidence, ServerEvidence, ServerVerdict,
  SessionMeta } from '../types.js';

const MS_PER_DAY = 86_400_000;
const LOW_SESSIONS = 5;
const LOW_DAYS = 3;
const HIGH_SESSIONS = 10;
const HIGH_DAYS = 7;

/** ISO string -> epoch ms. Unparsable and null both give null (string comparison breaks once offset notations mix). */
function ms(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Keeps the earlier of the two ISO timestamps. */
function earlier(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return (ms(b) ?? Infinity) < (ms(a) ?? Infinity) ? b : a;
}

/** Keeps the later of the two ISO timestamps. */
function later(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return (ms(b) ?? -Infinity) > (ms(a) ?? -Infinity) ? b : a;
}

/**
 * Confidence grade for remove-server. Same thresholds as the tool-level removeConfidence, and
 * where boundaries overlap the lower side wins, so the low conditions are checked first.
 * "never called" is part of the verdict itself, so it is not re-checked here.
 */
export function serverRemoveConfidence(ev: ServerEvidence): RecommendationConfidence {
  if (ev.configuredSessions < LOW_SESSIONS) return 'low';
  if (ev.observedDays == null || ev.observedDays < LOW_DAYS) return 'low';
  // high must clear the threshold on date-confirmed sessions alone: sessions of unknown date are
  // not evidence that the server was configured inside the window.
  if (ev.configuredSessions >= HIGH_SESSIONS
    && ev.datedConfiguredSessions >= HIGH_SESSIONS
    && ev.observedDays >= HIGH_DAYS) return 'high';
  return 'medium';
}

const EMPTY_SERVER_EVIDENCE: ServerEvidence = {
  configuredSessions: 0, datedConfiguredSessions: 0, loadedSessions: 0, calledSessions: 0,
  observedDays: null, lastActivityAt: null,
};

/**
 * One verdict per defined server, name-ordered. Servers with no definition are out of scope:
 * without a definition there is nothing to say about what removing the server would save.
 */
export function buildServerVerdicts(input: EngineInput): ServerVerdict[] {
  const { definitions, calls, loads, sessions } = input;

  const servers = [...new Set(definitions.map((d) => d.serverName))].sort();
  const mode = dominantMode(sessions);
  const deferred = mode === 'DEFERRED_MEASURABLE' || mode === 'DEFERRED_ESTIMATED';
  const instructionsByServer = instructionsTokensByServer(input.serverOverheads ?? []);

  const startedAt = new Map(sessions.map((s) => [s.sessionId, s.startedAt]));

  // Per-server aggregates gathered in one pass over the raw events.
  const scanEpoch = new Map<string, string>();       // min firstScannedAt across the server's definitions
  const firstActivity = new Map<string, string>();   // min startedAt across sessions with a call or load
  const definitionCount = new Map<string, number>();
  const definitionTokens = new Map<string, number>();
  const callSessions = new Map<string, Set<string>>();
  const loadSessions = new Map<string, Set<string>>();

  for (const d of definitions) {
    definitionCount.set(d.serverName, (definitionCount.get(d.serverName) ?? 0) + 1);
    definitionTokens.set(d.serverName,
      (definitionTokens.get(d.serverName) ?? 0) + d.definitionTokens);
    const prev = scanEpoch.get(d.serverName) ?? null;
    const next = earlier(prev, d.firstScannedAt);
    if (next != null) scanEpoch.set(d.serverName, next);
  }
  const noteActivity = (server: string, sessionId: string) => {
    const at = startedAt.get(sessionId) ?? null;
    if (at == null) return;
    const next = earlier(firstActivity.get(server) ?? null, at);
    if (next != null) firstActivity.set(server, next);
  };
  const addSession = (map: Map<string, Set<string>>, server: string, sessionId: string) => {
    let set = map.get(server);
    if (set === undefined) { set = new Set(); map.set(server, set); }
    set.add(sessionId);
  };
  for (const c of calls) {
    noteActivity(c.serverName, c.sessionId);
    addSession(callSessions, c.serverName, c.sessionId);
  }
  for (const l of loads) {
    if (l.serverName == null) continue; // unjoined loads cannot be attributed to a server
    noteActivity(l.serverName, l.sessionId);
    addSession(loadSessions, l.serverName, l.sessionId);
  }

  // Window end = the latest session we hold, shared by every server.
  let windowEnd: string | null = null;
  for (const s of sessions) if (s.startedAt != null) windowEnd = later(windowEnd, s.startedAt);
  const windowEndMs = ms(windowEnd);

  // No mapping at all, or a completely empty one, means "no mapping information" (a DB written
  // before the first scan): every server counts as configured for every client, as the tool-level
  // evidence already does.
  const byClient = input.serversByClient && input.serversByClient.size > 0
    ? input.serversByClient : undefined;
  const isConfigured = (server: string, client: SessionMeta['client']) =>
    byClient === undefined ? true : (byClient.get(client)?.has(server) ?? false);

  return servers.map((server): ServerVerdict => {
    const windowStart = earlier(scanEpoch.get(server) ?? null, firstActivity.get(server) ?? null);
    const windowStartMs = ms(windowStart);
    const defCount = definitionCount.get(server) ?? 0;
    const instructions = instructionsByServer.get(server) ?? 0;
    const measuredPerSessionTokens =
      deferred ? instructions : (definitionTokens.get(server) ?? 0) + instructions;
    const unmeasuredNameListEntries = deferred ? defCount : 0;

    // No lower bound for the window means there is nothing to judge: claim no observation rather
    // than counting every session we happen to hold.
    if (windowStartMs == null) {
      return { serverName: server, action: 'keep', confidence: 'high',
        evidence: { ...EMPTY_SERVER_EVIDENCE }, measuredPerSessionTokens,
        nameListTokens: null, unmeasuredNameListEntries, reason: 'no observation window' };
    }

    // A session with no startedAt cannot be placed in the window, so it is included (prevents
    // undercounting; the same documented limitation as the tool-level evidence).
    const inWindow = (s: SessionMeta): boolean => {
      const at = ms(s.startedAt);
      if (at == null) return true;
      if (at < windowStartMs) return false;
      return windowEndMs == null || at <= windowEndMs;
    };

    let configuredSessions = 0;
    let datedConfiguredSessions = 0;
    const windowSessionIds = new Set<string>();
    for (const s of sessions) {
      if (!inWindow(s)) continue;
      windowSessionIds.add(s.sessionId);
      // DEFERRED_OPAQUE carries no MCP evidence at all, so it proves nothing about the server
      // either. UPFRONT and the deferred modes both had the definitions or the name list.
      if (s.mode === 'DEFERRED_OPAQUE') continue;
      if (!isConfigured(server, s.client)) continue;
      configuredSessions++;
      if (ms(s.startedAt) != null) datedConfiguredSessions++;
    }

    const loadedIds = loadSessions.get(server);
    const calledIds = callSessions.get(server);
    let loadedSessions = 0;
    let calledSessions = 0;
    for (const id of windowSessionIds) {
      if (loadedIds?.has(id)) loadedSessions++;
      if (calledIds?.has(id)) calledSessions++;
    }

    // floor: an unfinished day must never bump the grade up ("the lower side wins")
    const observedDays = configuredSessions === 0 || windowEndMs == null
      ? null
      : Math.max(0, Math.floor((windowEndMs - windowStartMs) / MS_PER_DAY));

    // Latest evidence of life, from the window and from the all-time call history alike: a server
    // last called before the window is still a server we used to use, and removing it is not free.
    let lastActivityAt: string | null = null;
    for (const c of calls) {
      if (c.serverName !== server || c.calledAt == null) continue;
      if (!windowSessionIds.has(c.sessionId)) continue;
      lastActivityAt = later(lastActivityAt, c.calledAt);
    }
    for (const s of sessions) {
      if (s.startedAt == null || !windowSessionIds.has(s.sessionId)) continue;
      if (!loadedIds?.has(s.sessionId)) continue;
      lastActivityAt = later(lastActivityAt, s.startedAt);
    }
    for (const [k, at] of input.lastCallByTool ?? []) {
      if (!k.startsWith(`${server} `)) continue;
      lastActivityAt = later(lastActivityAt, at);
    }

    const evidence: ServerEvidence = { configuredSessions, datedConfiguredSessions,
      loadedSessions, calledSessions, observedDays, lastActivityAt };

    // Server removal is the recommendation with the least room for regret, so only "never loaded,
    // never called, no history at all" qualifies. A server with loads is trimmed tool by tool.
    if (loadedSessions === 0 && calledSessions === 0 && lastActivityAt == null) {
      const days = observedDays == null ? '' : `/${observedDays}d`;
      const plus = unmeasuredNameListEntries > 0
        ? ` plus ${unmeasuredNameListEntries} name-list entries (unmeasured)` : '';
      return { serverName: server, action: 'remove-server',
        confidence: serverRemoveConfidence(evidence), evidence, measuredPerSessionTokens,
        nameListTokens: null, unmeasuredNameListEntries,
        reason: `never loaded or called in ${configuredSessions} sessions${days}. `
          + `Removing saves about ${formatTokens(measuredPerSessionTokens)} tokens per session${plus}` };
    }
    // Any evidence of use is self-evident, so a keep is pinned high.
    // With nothing inside the window, the only thing keeping the server is older history, so the
    // reason says when that was instead of claiming "loaded in 0 sessions".
    const reason = calledSessions > 0
      ? `called in ${calledSessions} sessions`
      : loadedSessions > 0
        ? `loaded in ${loadedSessions} sessions, never called`
        : `last active ${(lastActivityAt ?? '').slice(0, 10)}, before the window`;
    return { serverName: server, action: 'keep', confidence: 'high', evidence,
      measuredPerSessionTokens, nameListTokens: null, unmeasuredNameListEntries, reason };
  });
}
