// packages/core/src/engine/evidence.ts
// 권고의 "얼마나 관찰했는가"를 산정하는 순수 모듈.
// engine.ts는 이 결과를 Recommendation에 조립하기만 한다.
import type { RecommendationConfidence, RecommendationEvidence, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';

/** high 확신에 필요한 최소 관찰량 — reason 문구의 "N세션 누적 시 확정"에도 쓰인다 */
export const HIGH_CONFIDENCE_SESSIONS = 10;
const HIGH_CONFIDENCE_DAYS = 7;
const LOW_CONFIDENCE_SESSIONS = 5;
const LOW_CONFIDENCE_DAYS = 3;
/** inspect 표본이 이 이상이면 high */
const INSPECT_HIGH_CALLS = 10;
const MS_PER_DAY = 86_400_000;

export const EMPTY_EVIDENCE: RecommendationEvidence = {
  observedSessions: 0, observedDays: null, lastCalledAt: null,
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
  /** 스코프 내 최대 세션 startedAt — 창의 끝 */
  windowEnd: string | null;
  /** "server tool" → 창 안 마지막 호출 시각 */
  lastCallInScope: Map<string, string>;
  /** "server tool" → 전 기간 마지막 호출 시각 (창 밖 과거 사용 포함) */
  lastCallAllTime: Map<string, string>;
  /** "server tool" → firstScannedAt */
  firstScanned: Map<string, string>;
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
  const noteActivity = (server: string | null, sessionId: string) => {
    if (server == null) return;
    const at = startedAt.get(sessionId) ?? null;
    if (at == null) return;
    const prev = serverFirstActivity.get(server);
    if (prev === undefined || (ms(at) ?? Infinity) < (ms(prev) ?? Infinity))
      serverFirstActivity.set(server, at);
  };
  for (const c of calls) noteActivity(c.serverName, c.sessionId);
  for (const l of loads) noteActivity(l.serverName, l.sessionId);

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

  return { sessions, serverFirstActivity, windowEnd, lastCallInScope,
    lastCallAllTime, firstScanned };
}

export function toolEvidence(
  serverName: string,
  toolName: string,
  definitionTokens: number | null,
  ctx: EvidenceContext,
): RecommendationEvidence {
  const k = key(serverName, toolName);
  // 창 시작 = min(정의 최초 관찰, 서버 최초 활동).
  // 둘 다 없으면(정의 미확보 + 활동 세션 startedAt 없음) 창 하한이 없다.
  const bounds = [ms(ctx.firstScanned.get(k)), ms(ctx.serverFirstActivity.get(serverName))]
    .filter((v): v is number => v != null);
  const windowStart = bounds.length ? Math.min(...bounds) : null;
  const windowEnd = ms(ctx.windowEnd);

  let observedSessions = 0;
  for (const s of ctx.sessions) {
    const at = ms(s.startedAt);
    // startedAt 없는 세션은 창 판정 불가 → 포함 (과소평가 방지, 문서화된 한계)
    if (at == null) { observedSessions++; continue; }
    if (windowStart != null && at < windowStart) continue;
    if (windowEnd != null && at > windowEnd) continue;
    observedSessions++;
  }

  const observedDays =
    observedSessions === 0 || windowStart == null || windowEnd == null
      ? null
      : Math.max(0, Math.round((windowEnd - windowStart) / MS_PER_DAY));

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
    observedDays,
    lastCalledAt,
    costPerSession,
    totalObservedCost: costPerSession == null ? null : costPerSession * observedSessions,
  };
}

/**
 * remove / filter-server의 확신 등급.
 * 경계가 겹치면 낮은 쪽이 이긴다 — low 조건을 먼저 본다.
 */
export function removeConfidence(ev: RecommendationEvidence): RecommendationConfidence {
  if (ev.observedSessions < LOW_CONFIDENCE_SESSIONS) return 'low';
  if (ev.observedDays == null || ev.observedDays < LOW_CONFIDENCE_DAYS) return 'low';
  if (ev.observedSessions >= HIGH_CONFIDENCE_SESSIONS
    && ev.observedDays >= HIGH_CONFIDENCE_DAYS
    && ev.lastCalledAt == null) return 'high';
  return 'medium';
}

/** inspect는 기존 게이트(호출 ≥3, 실패율 ≥50%)를 통과한 뒤 표본 크기로만 등급을 나눈다 */
export function inspectConfidence(callCount: number): RecommendationConfidence {
  return callCount >= INSPECT_HIGH_CALLS ? 'high' : 'medium';
}

/** remove/filter-server reason에 붙는 확신 꼬리말 */
export function confidencePhrase(
  confidence: RecommendationConfidence,
  ev: RecommendationEvidence,
): string {
  const days = ev.observedDays == null ? '' : `/${ev.observedDays}일`;
  if (confidence === 'low')
    return ` — 관찰 부족(${ev.observedSessions}세션${days}), `
      + `${HIGH_CONFIDENCE_SESSIONS}세션 누적 시 확정. 아직 확정 권고 아님`;
  if (confidence === 'medium' && ev.lastCalledAt != null)
    return ` — 마지막 호출 ${ev.lastCalledAt.slice(0, 10)}, 저빈도 툴일 수 있음. `
      + `삭제보다 지연 로딩 유지 검토`;
  if (confidence === 'medium')
    return ` — ${ev.observedSessions}세션${days} 관찰, 추가 관찰 시 확정`;
  return ` — ${ev.observedSessions}세션${days} 관찰, `
    + `누적 부담 ${ev.totalObservedCost ?? 0}토큰. 설정 한 줄로 복구 가능`;
}
