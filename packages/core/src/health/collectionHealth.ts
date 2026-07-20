import type { CollectionHealth, HookPhase } from '../ingest/contracts.js';

export const CORRELATION_GRACE_MS = 10_000;
export const MISSES_TO_DEGRADE = 3;
export const MATCHES_TO_RECOVER = 2;

export interface CollectionHealthObservation {
  source: 'hook' | 'log';
  phase: HookPhase;
  correlationKey: string | null;
  observedAt: string;
}

export interface CollectionHealthInput {
  now: string;
  observations: readonly CollectionHealthObservation[];
  sourceAvailability?: {
    hook: boolean;
    log: boolean;
  };
}

export interface CollectionHealthSnapshot {
  health: CollectionHealth;
  hookObserved: boolean;
  logObserved: boolean;
  consecutiveMisses: number;
  consecutiveMatches: number;
  waitingForCorrelation: number;
  lastEventAt: string | null;
}

interface TimedObservation extends CollectionHealthObservation {
  time: number;
}

type CorrelationOutcome = { kind: 'match' | 'miss'; time: number };

const COMPLETED_CALL_PHASES = new Set<HookPhase>(['tool-after', 'tool-failure']);

/**
 * Derives collection confidence from already persisted evidence. Time alone never
 * changes an idle collector into a failure; it only matures an eligible log call
 * into a correlation miss after the grace period.
 */
export function deriveCollectionHealth(input: CollectionHealthInput): CollectionHealthSnapshot {
  const now = Date.parse(input.now);
  const observations = input.observations
    .map((observation): TimedObservation => ({
      ...observation,
      time: Date.parse(observation.observedAt),
    }))
    .filter((observation) => Number.isFinite(observation.time))
    .sort(compareObservations);

  const hookObserved = observations.some((observation) => observation.source === 'hook');
  const logObserved = observations.some((observation) => observation.source === 'log');
  const last = observations.at(-1);

  // Miss maturity cannot be evaluated without a valid clock. Report explicit
  // unavailability instead of silently leaving old misses pending/healthy.
  if (!Number.isFinite(now)) {
    return {
      health: 'unavailable',
      hookObserved,
      logObserved,
      consecutiveMisses: 0,
      consecutiveMatches: 0,
      waitingForCorrelation: 0,
      lastEventAt: last?.observedAt ?? null,
    };
  }

  const unavailable = observations.length === 0
    && input.sourceAvailability?.hook === false
    && input.sourceAvailability.log === false;

  const hookTimesByKey = new Map<string, number[]>();
  for (const observation of observations) {
    if (observation.source !== 'hook'
      || !COMPLETED_CALL_PHASES.has(observation.phase)
      || observation.correlationKey === null) continue;
    const times = hookTimesByKey.get(observation.correlationKey) ?? [];
    times.push(observation.time);
    hookTimesByKey.set(observation.correlationKey, times);
  }

  let waitingForCorrelation = 0;
  const outcomes: CorrelationOutcome[] = [];
  for (const observation of observations) {
    if (observation.source !== 'log'
      || !COMPLETED_CALL_PHASES.has(observation.phase)
      || observation.correlationKey === null) continue;

    const hookTimes = hookTimesByKey.get(observation.correlationKey);
    const matchedHookIndex = hookTimes?.findIndex((hookTime) =>
      Math.abs(hookTime - observation.time) <= CORRELATION_GRACE_MS) ?? -1;
    if (matchedHookIndex >= 0 && hookTimes !== undefined) {
      hookTimes.splice(matchedHookIndex, 1);
      outcomes.push({ kind: 'match', time: observation.time });
    } else if (now - observation.time >= CORRELATION_GRACE_MS) {
      outcomes.push({ kind: 'miss', time: observation.time });
    } else {
      waitingForCorrelation++;
    }
  }

  // Equal-time observations are one logical batch. Apply misses before matches
  // so recovery evidence at that instant wins deterministically over stale loss.
  outcomes.sort((a, b) => a.time - b.time || outcomeRank(a) - outcomeRank(b));
  let degraded = false;
  let consecutiveMisses = 0;
  let consecutiveMatches = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'miss') {
      consecutiveMisses++;
      consecutiveMatches = 0;
      if (consecutiveMisses >= MISSES_TO_DEGRADE) degraded = true;
    } else {
      consecutiveMatches++;
      consecutiveMisses = 0;
      if (degraded && consecutiveMatches >= MATCHES_TO_RECOVER) degraded = false;
    }
  }

  let health: CollectionHealth;
  if (unavailable) health = 'unavailable';
  else if (degraded) health = 'degraded';
  else if (hookObserved && logObserved) health = 'healthy';
  else if (hookObserved) health = 'hook-only';
  else if (logObserved) health = 'log-only';
  else health = 'idle';

  return {
    health,
    hookObserved,
    logObserved,
    consecutiveMisses,
    consecutiveMatches,
    waitingForCorrelation,
    lastEventAt: last?.observedAt ?? null,
  };
}

function compareObservations(a: TimedObservation, b: TimedObservation): number {
  return a.time - b.time
    || a.source.localeCompare(b.source)
    || a.phase.localeCompare(b.phase)
    || (a.correlationKey ?? '').localeCompare(b.correlationKey ?? '')
    || a.observedAt.localeCompare(b.observedAt);
}

function outcomeRank(outcome: CorrelationOutcome): number {
  return outcome.kind === 'miss' ? 0 : 1;
}
