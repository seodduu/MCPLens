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
  /**
   * 툴 단계(tool-before/tool-after/tool-failure) hook이 한 번이라도 관측됐는가.
   * 라이프사이클 hook(session-start/turn-stop)은 포함하지 않는다 — 그것은 툴 상관
   * 커버리지를 증명하지 못한다. degraded 승격의 전제 조건이다.
   */
  toolHookCoverageObserved: boolean;
  consecutiveMisses: number;
  consecutiveMatches: number;
  waitingForCorrelation: number;
  lastEventAt: string | null;
}

interface TimedObservation extends CollectionHealthObservation {
  time: number;
}

type CorrelationOutcome = { kind: 'match' | 'miss'; time: number };

/** log 쪽에서 상관 성사 여부를 따지는 대상. 완료된 호출만 센다. */
const COMPLETED_CALL_PHASES = new Set<HookPhase>(['tool-after', 'tool-failure']);

/**
 * hook 쪽에서 커버리지 증거로 인정하는 단계.
 * 클라이언트는 이벤트별로 hook을 따로 켤 수 있고(codex의 `hooks.state.*.enabled`),
 * 시작 단계만 켜고 완료 단계는 꺼 둔 구성이 실기기에서 관측됐다. 완료 단계만 인정하면
 * 그런 구성에서 상관키가 일치하는데도 전부 miss가 되어 건강도가 degraded로 굳고,
 * 회복 조건인 2연속 match가 영원히 성립하지 않는다.
 * 건강도는 수집기 생존을 재는 지표이므로 시작 단계 관측도 커버리지로 인정한다.
 */
const HOOK_COVERAGE_PHASES = new Set<HookPhase>(['tool-before', 'tool-after', 'tool-failure']);

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
      toolHookCoverageObserved: false,
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
      || !HOOK_COVERAGE_PHASES.has(observation.phase)
      || observation.correlationKey === null) continue;
    const times = hookTimesByKey.get(observation.correlationKey) ?? [];
    times.push(observation.time);
    hookTimesByKey.set(observation.correlationKey, times);
  }

  // 툴 단계 hook 커버리지가 성립한 시점. hookTimesByKey는 HOOK_COVERAGE_PHASES만 담으므로
  // 이 맵이 비어 있다는 것은 툴 단계 hook을 한 번도 못 봤다는 뜻이다.
  // 최솟값을 쓰는 이유: 그 시각부터가 "hook이 이 호출을 봤어야 하는" 구간이다.
  const toolHookTimes = [...hookTimesByKey.values()].flat();
  const coverageSince = toolHookTimes.length === 0 ? null : Math.min(...toolHookTimes);
  const toolHookCoverageObserved = coverageSince !== null;

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
      // 툴 단계 hook을 한 번도 못 본 클라이언트에서 miss는 수집기 장애의 증거가 아니다.
      // hook 없이 로그만으로 운용하는 정상 형태이며, 그것은 log-only로 표기된다.
      //
      // 커버리지가 성립하기 이전의 log 완료도 마찬가지다. 그때는 수집기가 붙어 있지
      // 않았으므로 짝이 없는 것이 당연하고, "돌던 수집기가 멈췄다"는 회귀의 증거가 될 수
      // 없다. 이 시점 조건이 없으면 훅을 새로 켠 사용자가 과거 이력만큼의 miss를 안고
      // degraded로 시작하고, 매치를 만들어 빠져나올 때까지 전역 액션이 막힌다.
      // (실측: 훅 설치 직후 codex의 miss 116건이 전부 커버리지 성립 이전이었다.)
      if (coverageSince !== null
        && outcome.time >= coverageSince
        && consecutiveMisses >= MISSES_TO_DEGRADE) degraded = true;
    } else {
      consecutiveMatches++;
      consecutiveMisses = 0;
      if (degraded && consecutiveMatches >= MATCHES_TO_RECOVER) degraded = false;
    }
  }

  let health: CollectionHealth;
  if (unavailable) health = 'unavailable';
  else if (degraded) health = 'degraded';
  // 툴 단계 hook이 성립한 적 없으면 라이프사이클 hook이 있어도 툴 상관은 log 단독 운용이다.
  // healthy로 표기하면 "hook+로그 양쪽 정상"이라는 거짓 정보가 된다.
  else if (logObserved && !toolHookCoverageObserved) health = 'log-only';
  else if (hookObserved && logObserved) health = 'healthy';
  else if (hookObserved) health = 'hook-only';
  else if (logObserved) health = 'log-only';
  else health = 'idle';

  return {
    health,
    hookObserved,
    logObserved,
    toolHookCoverageObserved,
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
