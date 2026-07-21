import { createHash } from 'node:crypto';
import type { AdapterResult, ToolCallEvent, ToolLoadEvent } from '../types.js';
import type { ToolObservation } from '../ingest/contracts.js';
import { CORRELATION_GRACE_MS } from '../health/collectionHealth.js';

const COMPLETED_PHASES = new Set(['tool-after', 'tool-failure']);
const UNKNOWN_OBSERVED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Reduces privacy-safe observations to the pre-hook AdapterResult contract.
 * Hook data owns call identity, errors, and duration; logs own metering.
 */
export function materializeSession(observations: readonly ToolObservation[]): AdapterResult {
  const ordered = [...observations].sort(compareObservations);
  const first = ordered[0];
  if (!first) return emptyResult();

  const toolCalls: ToolCallEvent[] = [];
  for (const group of groupsByCorrelation(ordered)) {
    for (const { hook, log } of pairCompleted(group)) {
      const identity = hook ?? log;
      if (!identity || identity.serverName === null || identity.toolName === null) continue;
      toolCalls.push({
        sessionId: sessionIdFor(first),
        serverName: identity.serverName,
        toolName: identity.toolName,
        calledAt: identity.observedAt,
        durationMs: firstNonNull(hook?.durationMs, log?.durationMs),
        isError: firstNonNull(hook?.isError, log?.isError) ?? false,
        responseTokens: firstNonNull(log?.responseTokens, hook?.responseTokens),
        responseText: null,
        externalCallId: identity.externalCallId,
      });
    }
  }

  const toolLoads: ToolLoadEvent[] = ordered
    .filter((item) => item.source === 'log'
      && item.phase === 'tool-before'
      && item.toolName !== null)
    .map((item) => ({
      sessionId: sessionIdFor(first), serverName: item.serverName,
      toolName: item.toolName!, loadedTokens: item.loadedTokens,
    }));

  return {
    session: {
      sessionId: sessionIdFor(first), client: first.client, filePath: deterministicTranscriptPath(ordered),
      externalSessionId: first.externalSessionId, startedAt: earliestObservedAt(ordered),
      mode: 'DEFERRED_OPAQUE',
    },
    toolCalls, toolLoads, usage: [], parseErrors: 0,
  };
}

export function sessionIdFor(observation: Pick<ToolObservation, 'client' | 'externalSessionId'>): string {
  return `observation:${createHash('sha256')
    .update(JSON.stringify([observation.client, observation.externalSessionId]))
    .digest('hex')}`;
}

function groupsByCorrelation(observations: readonly ToolObservation[]): ToolObservation[][] {
  const groups = new Map<string, ToolObservation[]>();
  for (const observation of observations) {
    const key = materializationGroupKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function materializationGroupKey(observation: ToolObservation): string {
  if (!COMPLETED_PHASES.has(observation.phase)
    || observation.correlationConfidence === 'high'
    || !observation.correlationKey.startsWith('fallback:')) {
    return `exact:${observation.correlationKey}`;
  }
  const logicalIdentity = [
    observation.client,
    observation.externalSessionId,
    observation.externalTurnId,
    observation.serverName,
    observation.toolName,
    observation.inputFingerprint,
  ];
  return `fallback-completed:${createHash('sha256')
    .update(JSON.stringify(logicalIdentity))
    .digest('hex')}`;
}

function completedFrom(
  observations: readonly ToolObservation[],
  source: 'hook' | 'log',
): ToolObservation[] {
  return observations.filter((item) =>
    item.source === source && COMPLETED_PHASES.has(item.phase));
}

interface CompletedPair {
  hook?: ToolObservation;
  log?: ToolObservation;
}

type AlignmentAction = 'done' | 'match' | 'skip-hook' | 'skip-log';

interface AlignmentCell {
  matches: number;
  distance: number;
  action: AlignmentAction;
}

function pairCompleted(observations: readonly ToolObservation[]): CompletedPair[] {
  const hooks = completedFrom(observations, 'hook').sort(compareObservations);
  const logs = completedFrom(observations, 'log').sort(compareObservations);
  if (!usesFallbackTimeAlignment(observations)) {
    return Array.from({ length: Math.max(hooks.length, logs.length) }, (_, index) => ({
      hook: hooks[index],
      log: logs[index],
    })).sort((a, b) => compareObservations((a.hook ?? a.log)!, (b.hook ?? b.log)!));
  }
  const alignment = buildAlignment(hooks, logs);
  const pairs: CompletedPair[] = [];
  let hookIndex = 0;
  let logIndex = 0;
  while (hookIndex < hooks.length || logIndex < logs.length) {
    const action = alignment[hookIndex]![logIndex]!.action;
    if (action === 'match') {
      pairs.push({ hook: hooks[hookIndex], log: logs[logIndex] });
      hookIndex++;
      logIndex++;
    } else if (action === 'skip-hook') {
      pairs.push({ hook: hooks[hookIndex] });
      hookIndex++;
    } else if (action === 'skip-log') {
      pairs.push({ log: logs[logIndex] });
      logIndex++;
    } else {
      break;
    }
  }
  return pairs.sort((a, b) => compareObservations((a.hook ?? a.log)!, (b.hook ?? b.log)!));
}

function usesFallbackTimeAlignment(observations: readonly ToolObservation[]): boolean {
  return observations.every((observation) =>
    COMPLETED_PHASES.has(observation.phase)
    && observation.correlationConfidence !== 'high'
    && observation.correlationKey.startsWith('fallback:'));
}

function buildAlignment(
  hooks: readonly ToolObservation[],
  logs: readonly ToolObservation[],
): AlignmentCell[][] {
  const cells = Array.from({ length: hooks.length + 1 }, () =>
    Array.from({ length: logs.length + 1 }, (): AlignmentCell => ({
      matches: 0,
      distance: 0,
      action: 'done',
    })));

  for (let hookIndex = hooks.length; hookIndex >= 0; hookIndex--) {
    for (let logIndex = logs.length; logIndex >= 0; logIndex--) {
      if (hookIndex === hooks.length && logIndex === logs.length) continue;
      const candidates: AlignmentCell[] = [];
      if (hookIndex < hooks.length) {
        const suffix = cells[hookIndex + 1]![logIndex]!;
        candidates.push({ ...suffix, action: 'skip-hook' });
      }
      if (logIndex < logs.length) {
        const suffix = cells[hookIndex]![logIndex + 1]!;
        candidates.push({ ...suffix, action: 'skip-log' });
      }
      if (hookIndex < hooks.length && logIndex < logs.length) {
        const distance = observedTimeDistance(hooks[hookIndex]!, logs[logIndex]!);
        if (distance !== null && distance <= CORRELATION_GRACE_MS) {
          const suffix = cells[hookIndex + 1]![logIndex + 1]!;
          candidates.push({
            matches: suffix.matches + 1,
            distance: suffix.distance + distance,
            action: 'match',
          });
        }
      }
      cells[hookIndex]![logIndex] = candidates.reduce(betterAlignment);
    }
  }
  return cells;
}

function betterAlignment(best: AlignmentCell, candidate: AlignmentCell): AlignmentCell {
  if (candidate.matches !== best.matches) {
    return candidate.matches > best.matches ? candidate : best;
  }
  if (candidate.distance !== best.distance) {
    return candidate.distance < best.distance ? candidate : best;
  }
  return alignmentActionRank(candidate.action) < alignmentActionRank(best.action)
    ? candidate
    : best;
}

function alignmentActionRank(action: AlignmentAction): number {
  if (action === 'match') return 0;
  if (action === 'skip-hook') return 1;
  if (action === 'skip-log') return 2;
  return 3;
}

function observedTimeDistance(a: ToolObservation, b: ToolObservation): number | null {
  const left = Date.parse(a.observedAt);
  const right = Date.parse(b.observedAt);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) : null;
}

function firstNonNull<T>(...values: readonly (T | null | undefined)[]): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function compareObservations(a: ToolObservation, b: ToolObservation): number {
  return compareObservedAt(a.observedAt, b.observedAt)
    || compareDeliveryIds(a.deliveryId, b.deliveryId)
    || a.source.localeCompare(b.source);
}

function compareObservedAt(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
  return a.localeCompare(b);
}

function compareDeliveryIds(a: string, b: string): number {
  const left = /^log:(\d+):(.*)$/.exec(a);
  const right = /^log:(\d+):(.*)$/.exec(b);
  if (left && right) {
    const ordinal = Number(left[1]) - Number(right[1]);
    if (ordinal !== 0) return ordinal;
    return left[2]!.localeCompare(right[2]!);
  }
  return a.localeCompare(b);
}

function earliestObservedAt(observations: readonly ToolObservation[]): string | null {
  let earliest: { value: string; time: number } | null = null;
  for (const observation of observations) {
    if (observation.observedAt === UNKNOWN_OBSERVED_AT) continue;
    const time = Date.parse(observation.observedAt);
    if (!Number.isFinite(time)) continue;
    if (earliest === null || time < earliest.time
      || (time === earliest.time && observation.observedAt.localeCompare(earliest.value) < 0)) {
      earliest = { value: observation.observedAt, time };
    }
  }
  return earliest?.value ?? null;
}

function deterministicTranscriptPath(observations: readonly ToolObservation[]): string | null {
  const paths = observations
    .map((observation) => observation.transcriptPath)
    .filter((path): path is string => path !== null)
    .sort((a, b) => a.localeCompare(b));
  return paths[0] ?? null;
}

function emptyResult(): AdapterResult {
  return {
    session: {
      sessionId: '', client: 'codex', filePath: null, externalSessionId: null,
      startedAt: null, mode: 'DEFERRED_OPAQUE',
    },
    toolCalls: [], toolLoads: [], usage: [], parseErrors: 0,
  };
}
