// packages/core/src/engine/evidence.ts
// 권고의 "얼마나 관찰했는가"를 산정하는 순수 모듈.
// engine.ts는 이 결과를 Recommendation에 조립하기만 한다.
import type { RecommendationConfidence, RecommendationEvidence, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';
import { formatTokens } from './format.js';

/** high 확신에 필요한 최소 관찰량. reason 문구의 "N세션 누적 시 확정"에도 쓰인다 */
export const HIGH_CONFIDENCE_SESSIONS = 10;
const HIGH_CONFIDENCE_DAYS = 7;
const LOW_CONFIDENCE_SESSIONS = 5;
const LOW_CONFIDENCE_DAYS = 3;
/** inspect 표본이 이 이상이면 high */
const INSPECT_HIGH_CALLS = 10;
const MS_PER_DAY = 86_400_000;

export const EMPTY_EVIDENCE: RecommendationEvidence = {
  observedSessions: 0, datedObservedSessions: 0, observedDays: null, lastCalledAt: null,
  costPerSession: null, totalObservedCost: null,
};

const key = (server: string, tool: string) => `${server} ${tool}`;

/** ISO 문자열 → epoch ms. 파싱 불가·null은 null (문자열 비교는 오프셋 표기가 섞이면 틀린다) */
function ms(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export interface EvidenceContext {
  sessions: SessionMeta[];
  /** 서버명 → 그 서버의 활동(호출·로드)이 있는 가장 이른 세션 startedAt */
  serverFirstActivity: Map<string, string>;
  /**
   * 서버명 → 그 서버에 정의가 있는 모든 툴의 firstScannedAt 중 최소값 (= 서버 최초 스캔 시각).
   * 툴의 firstScannedAt이 이 값보다 나중이면 "기존 서버에 나중에 추가된 툴"이므로
   * 서버의 오래된 활동 이력을 물려받지 못하게 한다.
   */
  serverScanEpoch: Map<string, string>;
  /** 스코프 내 최대 세션 startedAt — 창의 끝 */
  windowEnd: string | null;
  /** "server tool" → 창 안 마지막 호출 시각 */
  lastCallInScope: Map<string, string>;
  /** "server tool" → 전 기간 마지막 호출 시각 (창 밖 과거 사용 포함) */
  lastCallAllTime: Map<string, string>;
  /** "server tool" → firstScannedAt */
  firstScanned: Map<string, string>;
  /**
   * "server tool" → 그 툴 자신의 활동(호출·로드)이 있는 가장 이른 세션 startedAt.
   * 정의를 못 잡은 툴(load-only)의 firstScannedAt 대체물 — 서버 단위 활동을 그대로 쓰면
   * 오래된 서버에 어제 처음 로드된 툴이 서버 전체 이력을 물려받아 거짓 확신을 만든다.
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

  // 스캔 전 세션이라도 그 서버의 호출·로드가 있으면 "서버가 구성돼 있었다"는 증거 → 창을 확장한다.
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
  for (const l of loads) noteActivity(l.serverName, l.toolName, l.sessionId);

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

  // 서버별 최초 스캔 시각 = 그 서버 툴들의 firstScannedAt 최소값
  const serverScanEpoch = new Map<string, string>();
  for (const d of definitions) {
    const at = ms(d.firstScannedAt);
    if (at == null) continue;
    const prev = serverScanEpoch.get(d.serverName);
    if (prev === undefined || at < (ms(prev) ?? Infinity))
      serverScanEpoch.set(d.serverName, d.firstScannedAt);
  }

  return { sessions, serverFirstActivity, serverScanEpoch, windowEnd, lastCallInScope,
    lastCallAllTime, firstScanned, toolFirstActivity };
}

export function toolEvidence(
  serverName: string,
  toolName: string,
  definitionTokens: number | null,
  ctx: EvidenceContext,
): RecommendationEvidence {
  const k = key(serverName, toolName);
  const toolFirstScanned = ms(ctx.firstScanned.get(k));
  const scanEpoch = ms(ctx.serverScanEpoch.get(serverName));
  const serverActivity = ms(ctx.serverFirstActivity.get(serverName));

  // 창 시작:
  //  - 툴 정의가 서버 최초 스캔보다 나중이면 = 기존 서버에 나중에 추가된 툴.
  //    이 툴에 대한 관찰은 추가 시점부터만 존재하므로 서버 활동으로 확장하지 않는다.
  //    (확장하면 하루 된 툴이 "47세션 관찰"로 둔갑해 거짓 확신을 만든다.)
  //  - 툴 정의가 서버 최초 스캔과 같으면 = 첫 스캔. 어댑터가 과거 세션을 백필하므로
  //    실제로 보유한 서버 활동 이력까지 창을 넓히는 것이 맞다.
  //  - 툴 정의가 없으면(load-only) 그 툴 자신의 최초 활동이 firstScannedAt의 대체물이다.
  //    서버 활동으로 확장하면 3주 된 서버에 어제 처음 로드된 툴이 "21세션 관찰"로 둔갑한다.
  //    (이름 조인 실패·스캐너 미커버 서버에서 상시 발생하는 경로다.)
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

  // 창 하한을 특정할 수 없으면(정의 미확보 + 서버 활동 증거 없음) 관찰량을 주장하지 않는다.
  // 전 세션을 계상하면 observedSessions·totalObservedCost가 근거 없이 부풀려진다.
  // startedAt이 null인 세션을 포함하는 규칙(아래)도 이 경우엔 적용하지 않는다 —
  // 그 규칙은 "유효한 창 안에서의 과소평가 방지"이지 창 자체를 만들어내는 근거가 아니다.
  let observedSessions = 0;
  // startedAt이 유효해 실제로 창 안임이 확인된 세션만 따로 센다.
  // startedAt이 null인 세션은 store.sessionsSince가 창 제약 없이 전 기간을 반환하므로
  // 이들만으로 high가 나면 "언제 것인지도 모르는 세션 N개"가 확신의 근거가 된다.
  let datedObservedSessions = 0;
  if (windowStart != null) {
    for (const s of ctx.sessions) {
      const at = ms(s.startedAt);
      // startedAt 없는 세션은 창 판정 불가 → 포함 (과소평가 방지, 문서화된 한계)
      if (at == null) { observedSessions++; continue; }
      if (at < windowStart) continue;
      if (windowEnd != null && at > windowEnd) continue;
      observedSessions++;
      datedObservedSessions++;
    }
  }

  // 내림(floor): 채우지 못한 하루가 등급을 한 단계 올리면 안 된다 ("낮은 쪽이 이긴다")
  const observedDays =
    observedSessions === 0 || windowStart == null || windowEnd == null
      ? null
      : Math.max(0, Math.floor((windowEnd - windowStart) / MS_PER_DAY));

  // 창 안 호출과 전 기간 이력 중 더 나중 — 전 기간 맵이 없으면 창 안 값으로 자연 열화
  const inScope = ctx.lastCallInScope.get(k) ?? null;
  const allTime = ctx.lastCallAllTime.get(k) ?? null;
  const lastCalledAt =
    inScope == null ? allTime
    : allTime == null ? inScope
    : (ms(allTime) ?? 0) > (ms(inScope) ?? 0) ? allTime : inScope;

  const costPerSession = definitionTokens;
  return {
    observedSessions,
    datedObservedSessions,
    observedDays,
    lastCalledAt,
    costPerSession,
    // 창 하한 자체가 없으면 관찰량 미상 → 누적 부담도 "모름"(null).
    // 0을 내보내면 UI에서 "부담 0토큰"으로 읽혀 EMPTY_EVIDENCE와 구분되지 않는다.
    totalObservedCost:
      costPerSession == null || windowStart == null ? null : costPerSession * observedSessions,
  };
}

/**
 * remove / filter-server의 확신 등급.
 * 경계가 겹치면 낮은 쪽이 이긴다 — low 조건을 먼저 본다.
 */
export function removeConfidence(ev: RecommendationEvidence): RecommendationConfidence {
  if (ev.observedSessions < LOW_CONFIDENCE_SESSIONS) return 'low';
  if (ev.observedDays == null || ev.observedDays < LOW_CONFIDENCE_DAYS) return 'low';
  // high는 startedAt이 확인된 세션만으로도 임계를 넘어야 한다 —
  // 시각 미상 세션이 쌓여 만든 observedSessions는 창 안 관찰의 증거가 아니다.
  if (ev.observedSessions >= HIGH_CONFIDENCE_SESSIONS
    && ev.datedObservedSessions >= HIGH_CONFIDENCE_SESSIONS
    && ev.observedDays >= HIGH_CONFIDENCE_DAYS
    && ev.lastCalledAt == null) return 'high';
  return 'medium';
}

/** inspect는 기존 게이트(호출 ≥3, 실패율 ≥50%)를 통과한 뒤 표본 크기로만 등급을 나눈다 */
export function inspectConfidence(callCount: number): RecommendationConfidence {
  return callCount >= INSPECT_HIGH_CALLS ? 'high' : 'medium';
}

/** remove/filter-server 확신 꼬리말의 알맹이 (구분자 없음). 리포트 렌더러는 이걸 쓴다 */
export function confidenceCaveat(
  confidence: RecommendationConfidence,
  ev: RecommendationEvidence,
): string {
  const days = ev.observedDays == null ? '' : `/${ev.observedDays}일`;
  if (confidence === 'low')
    return `관찰 부족(${ev.observedSessions}세션${days}), `
      + `${HIGH_CONFIDENCE_SESSIONS}세션 누적 시 확정. 아직 확정 권고 아님`;
  if (confidence === 'medium' && ev.lastCalledAt != null)
    return `마지막 호출 ${ev.lastCalledAt.slice(0, 10)}, 저빈도 툴일 수 있음. `
      + `삭제보다 지연 로딩 유지 검토`;
  if (confidence === 'medium')
    return `${ev.observedSessions}세션${days} 관찰, 추가 관찰 시 확정`;
  return `${ev.observedSessions}세션${days} 관찰, `
    + `누적 부담 ${formatTokens(ev.totalObservedCost ?? 0)}토큰. 설정 한 줄로 복구 가능`;
}

/** @deprecated 리포트 렌더러는 confidenceCaveat를 쓴다. reason 결합 호환용 */
export function confidencePhrase(
  confidence: RecommendationConfidence,
  ev: RecommendationEvidence,
): string {
  return `. ${confidenceCaveat(confidence, ev)}`;
}
