import type { DependencyCallRecord } from '../types.js';
import type { DependencyEvidence } from './merge.js';

/**
 * Minimum number of sessions in which A preceded B before the pair counts as a signal.
 * Below this the ordering is anecdote, not pattern. The reanalysis trigger reuses this value:
 * re-running the analysis is only worth its cost once this tier can produce a signal at all.
 */
export const CALL_CHAIN_MIN_SESSIONS = 3;

export interface CallChainOptions {
  now?: string;
}

export function findCallChainDependencies(
  calls: readonly DependencyCallRecord[],
  opts: CallChainOptions = {},
): DependencyEvidence[] {
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());
  const sinceMs = nowMs - 90 * 24 * 60 * 60 * 1000;
  const recentSuccess = calls
    .filter((call) => !call.isError)
    .filter((call) => call.calledAt === null || Date.parse(call.calledAt) >= sinceMs)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || sequenceTime(a) - sequenceTime(b) || a.sequence - b.sequence);

  const byServerSession = new Map<string, DependencyCallRecord[]>();
  for (const call of recentSuccess) {
    const key = `${call.serverName}\0${call.sessionId}`;
    const list = byServerSession.get(key) ?? [];
    list.push(call);
    byServerSession.set(key, list);
  }

  const toolNamesByServer = new Map<string, Set<string>>();
  for (const call of recentSuccess) {
    const set = toolNamesByServer.get(call.serverName) ?? new Set<string>();
    set.add(call.toolName);
    toolNamesByServer.set(call.serverName, set);
  }

  const evidence: DependencyEvidence[] = [];
  for (const [serverName, toolNames] of toolNamesByServer) {
    for (const a of toolNames) {
      for (const b of toolNames) {
        if (a === b) continue;
        let bSessions = 0;
        let before = 0;
        let bWithoutA = 0;
        for (const [key, sessionCalls] of byServerSession) {
          if (!key.startsWith(`${serverName}\0`)) continue;
          const firstB = sessionCalls.findIndex((call) => call.toolName === b);
          if (firstB < 0) continue;
          bSessions += 1;
          const hasABeforeB = sessionCalls.slice(0, firstB).some((call) => call.toolName === a);
          if (hasABeforeB) before += 1;
          else bWithoutA += 1;
        }
        if (before >= CALL_CHAIN_MIN_SESSIONS && before / bSessions >= 0.8 && bWithoutA < 2) {
          evidence.push({
            serverName,
            toolName: a,
            dependedOnBy: [b],
            evidence: [`call-chain:${b}:${before}/${bSessions}`],
          });
        }
      }
    }
  }
  return mergeEvidence(evidence);
}

function sequenceTime(call: DependencyCallRecord): number {
  return call.calledAt === null ? Number.NEGATIVE_INFINITY : Date.parse(call.calledAt);
}

function mergeEvidence(rows: DependencyEvidence[]): DependencyEvidence[] {
  const byTool = new Map<string, DependencyEvidence>();
  for (const row of rows) {
    const key = `${row.serverName}\0${row.toolName}`;
    const current = byTool.get(key) ?? { serverName: row.serverName, toolName: row.toolName, dependedOnBy: [], evidence: [] };
    current.dependedOnBy.push(...row.dependedOnBy.filter((tool) => !current.dependedOnBy.includes(tool)));
    current.evidence.push(...row.evidence.filter((item) => !current.evidence.includes(item)));
    byTool.set(key, current);
  }
  return [...byTool.values()].map((row) => ({
    ...row,
    dependedOnBy: row.dependedOnBy.sort(),
    evidence: row.evidence.sort(),
  })).sort((a, b) => a.serverName.localeCompare(b.serverName) || a.toolName.localeCompare(b.toolName));
}
