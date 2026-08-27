// packages/core/src/engine/cost.ts
// Accumulated cost calculation, split from the verdict logic (engine.ts) because the
// responsibilities differ.
// Design: docs/superpowers/specs/2026-07-21-매트릭스-누적비용-표시-design.md
// Pure functions: no side effects, no file IO.
import type { MatrixRow, Recommendation, ServerContextOverhead, ToolCallEvent } from '../types.js';

/** Same tool key format as the engine (engine.ts:26). If the two diverge, the join fails silently. */
export function toolCostKey(serverName: string, toolName: string): string {
  return `${serverName} ${toolName}`;
}

/**
 * "server tool" -> number of distinct sessions that called the tool.
 * Under deferred loading a tool can only be called after its definition was loaded, so this is a
 * lower bound on the number of load sessions (the lower-bound estimation principle, design v2 ch. 3).
 */
export function callSessionCounts(calls: ToolCallEvent[]): Map<string, number> {
  const sessions = new Map<string, Set<string>>();
  for (const c of calls) {
    const k = toolCostKey(c.serverName, c.toolName);
    let set = sessions.get(k);
    if (set === undefined) { set = new Set(); sessions.set(k, set); }
    set.add(c.sessionId);
  }
  const counts = new Map<string, number>();
  for (const [k, set] of sessions) counts.set(k, set.size);
  return counts;
}

/**
 * How much context an action actually takes away (plan
 * docs/plans/2026-08-27-툴정의-토큰-추정기-v2-구현계획.md section 3.5).
 * 'server-removal' also drops the server's `instructions` string, because the client stops
 * connecting to it. 'tool-filter' never does: the server keeps running and keeps sending its
 * instructions, even when every one of its tools is filtered out.
 */
export type SavingScope = 'server-removal' | 'tool-filter';

/**
 * Only a 'remove' verdict that covers every known tool of the server takes the server down with
 * it. Anything else (a partial 'remove', any 'filter-server') leaves the connection up, so it is
 * a tool filter. Deciding here rather than at each call site keeps the two from drifting apart.
 */
export function savingScope(
  action: Recommendation['action'],
  coversEveryTool: boolean,
): SavingScope {
  return action === 'remove' && coversEveryTool ? 'server-removal' : 'tool-filter';
}

/** definitionTokens plus the instructions overhead, but only for a server removal. */
export function attributedSaving(
  definitionTokens: number,
  instructionsTokens: number,
  scope: SavingScope,
): number {
  return scope === 'server-removal' ? definitionTokens + instructionsTokens : definitionTokens;
}

/**
 * server name -> instructions tokens. A server with no overhead row (an unscanned server, or a DB
 * written before the v2 estimator) is absent from the map and counts as 0: unknown overhead is
 * never invented into a saving.
 */
export function instructionsTokensByServer(
  overheads: readonly ServerContextOverhead[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of overheads) map.set(o.serverName, o.instructionsTokens);
  return map;
}

export interface CumulativeCost {
  /** Accumulated tokens. With unmeasured definitions it holds only the response part, so it is always a lower bound on the real cost. */
  tokens: number;
  /** false means definition tokens are unavailable (not covered by the scanner), so the definition part is missing. */
  definitionMeasured: boolean;
}

/**
 * Accumulated cost = (definition tokens x effective load sessions) + response tokens.
 * Effective load sessions = max(load sessions, distinct calling sessions): sessions collected
 * through hooks only carry no load events, so the call itself is used to infer them.
 */
export function cumulativeCost(row: MatrixRow, callSessionCount: number): CumulativeCost {
  const loadSessions = Math.max(row.loadedSessionCount, callSessionCount);
  const defTokens = row.definitionTokens;
  const definitionPart = defTokens != null ? defTokens * loadSessions : 0;
  return {
    tokens: definitionPart + row.responseTokens,
    // Never loaded means the definition part really is 0: a measured zero, not an unmeasured one.
    definitionMeasured: defTokens != null || loadSessions === 0,
  };
}
