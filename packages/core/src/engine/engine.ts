// packages/core/src/engine/engine.ts
import type { ClientId, LoadPattern, MatrixRow, Recommendation, RecommendationReason,
  SessionMeta, ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';
import { buildEvidenceContext, confidenceCaveat, EMPTY_EVIDENCE, inspectConfidence,
  removeConfidence, toolEvidence, type EvidenceContext } from './evidence.js';

export interface EngineInput {
  definitions: ToolDefinition[];
  calls: ToolCallEvent[];
  loads: ToolLoadEvent[];
  sessions: SessionMeta[];
  /**
   * "server tool" → 전 기간 마지막 호출 시각 (store.lastCallByTool()).
   * 선택 — 없으면 분석 창 안의 호출만으로 판정하며, 창 밖 과거 사용은 보이지 않는다.
   */
  lastCallByTool?: Map<string, string>;
  /**
   * 클라이언트 → 그 클라이언트에 설정된 서버 이름 집합 (store.serversByClient()).
   * 선택 — 없으면 정의를 필터링하지 않는다(기존 동작). 스캔 전 DB에서도 안전하다.
   */
  serversByClient?: Map<ClientId, Set<string>>;
}

// 판정 임계값 (설계문서 7장 기능 1 개정)
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

  // 서버별 사용률 (filter-server 판정용)
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

  // 정의된 툴 + 호출만 된 툴 + 로드만 된 툴의 합집합 (M4)
  // 로드만 된 툴을 빼면 "로드됐는데 호출 0회"(검색 공간 오염)가 표면화되지 않는다.
  const rows = new Map<string, MatrixRow>();
  for (const d of definitions) rows.set(key(d.serverName, d.toolName), baseRow(d.serverName, d.toolName, d.definitionTokens));
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    if (!rows.has(k)) rows.set(k, baseRow(c.serverName, c.toolName, null));
  }
  for (const l of loads) {
    if (l.serverName == null) continue; // 서버 귀속 불가 로드(코드모드 검색 집계 등)는 행 대상 아님
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
  // 키(서버/툴) 단위로 택일: 직접 기록(loadedTokens)이 있으면 그 값, 없으면 정의 조인값.
  // 정의가 없는 서버(스캔 미커버)의 로드는 비교집합 밖 — 제외 (potentialTokens와 집합 일치).
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
      reasonParts, evidenceLabel: '측정 불가', evidence: EMPTY_EVIDENCE },
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
 * 세션들의 지배 회계 모드. DEFERRED_OPAQUE는 "MCP 증거 없음"이지 모드의 증거가 아니므로
 * 다수결에서 제외한다 — 증거 있는 세션이 하나도 없을 때만 OPAQUE.
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
 * 모드 인지 표시 필터 (설계문서 4-2의 표시 계층 적용).
 * 지연 로딩: 호출 0 && 로드 0 툴은 실비용 0 → 숨김 (search-pollution은 로드분 실비용이 있어 유지).
 * 업프론트: 미사용 정의도 매 세션 실비용 → 전부 표시.
 * DB에는 전부 기록돼 있으며 이 필터는 표시 전용이다.
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
    mode === 'DEFERRED_MEASURABLE' ? '실측' :
    mode === 'DEFERRED_ESTIMATED' ? '하한 추정' :
    mode === 'UPFRONT' ? '전량 가정' : '측정 불가';
  const sizePhrase = (t: number) =>
    mode === 'UPFRONT'
      ? `제거 시 매 세션 약 ${t}토큰 절약`
      : `절약은 작지만 검색 공간 정리 효과`;

  const pollutionSuffix = row.loadPattern === 'search-pollution' ? ' (로드는 되나 호출 0회 — 검색 공간 오염)' : '';

  if (row.callCount === 0 && row.definitionTokens != null) {
    // 확신이 낮아도 판정은 강등하지 않는다 — 표면이 "후보"로 렌더링한다 (스펙 결정사항 2)
    const confidence = removeConfidence(evidence);
    const caveat = confidenceCaveat(confidence, evidence);
    if (server && server.total >= 10 && server.used > 0 && server.used / server.total < 0.2) {
      const reasonParts: RecommendationReason = {
        basis: '',
        serverBasis: `서버 ${row.serverName}의 ${server.total}툴 중 ${server.used}개만 사용 — 툴 필터링 권장.`,
        effect: `${sizePhrase(row.definitionTokens)}${pollutionSuffix}`,
        caveat,
      };
      return { action: 'filter-server', confidence, reason: joinReason(reasonParts), reasonParts,
        evidenceLabel, evidence };
    }
    const reasonParts: RecommendationReason = {
      basis: `정의 ${row.definitionTokens}토큰, 호출 0회`,
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
      basis: `${row.callCount}회 중 ${row.reliability.errorCount}회 실패(${rate}%), 실패 응답 ${row.reliability.failedResponseTokens}토큰 낭비`,
      serverBasis: null, effect: '점검·대체 권장', caveat: null,
    };
    return { action: 'inspect', confidence: inspectConfidence(row.callCount),
      reason: joinReason(reasonParts), reasonParts, evidenceLabel, evidence };
  }
  // 호출됨 = 자기 증명 → high 고정
  if (row.callCount > 0) {
    const reasonParts: RecommendationReason = {
      basis: `${row.callCount}회 호출됨`, serverBasis: null, effect: null, caveat: null };
    return { action: 'keep', confidence: 'high', reason: joinReason(reasonParts), reasonParts,
      evidenceLabel, evidence };
  }
  const reasonParts: RecommendationReason = {
    basis: '정의 토큰 미확보 (스캐너 미커버)', serverBasis: null, effect: null, caveat: null };
  return { action: 'unknown', confidence: 'low', reason: joinReason(reasonParts), reasonParts,
    evidenceLabel: '측정 불가', evidence };
}

/** parts → 현행 reason 문자열. 구분자 규칙이 여기 한 곳에만 있다 */
export function joinReason(p: RecommendationReason): string {
  // lead: serverBasis가 있으면 그것, 없으면 basis. 그 뒤 effect와의 구분자가 다르다:
  //   serverBasis 뒤엔 공백(' '), basis 뒤엔 ' — '. 원문 filter-server/remove의 차이 그대로.
  const lead = p.serverBasis ?? p.basis;
  let s = lead;
  if (p.effect != null) {
    s += p.serverBasis != null ? ` ${p.effect}` : ` — ${p.effect}`;
  }
  if (p.caveat != null) {
    s += ` — ${p.caveat}`;
  }
  return s;
}

/**
 * EngineInput을 클라이언트별로 분할한다 (클라이언트별 매트릭스 표시용).
 * definitions는 클라이언트 무관 공유 자원이므로 각 분할에 그대로 포함된다.
 * lastCallByTool도 같은 이유로 전 클라이언트 공통 맵을 각 분할에 그대로 넘긴다 —
 * 다른 클라이언트에서의 호출 이력은 "예전엔 쓰던 툴"의 증거이므로 확신을 낮추는
 * 쪽으로만 작용한다(high → medium). 보수적 방향이라 그대로 넘기는 것이 맞다.
 * 넘기지 않으면 "창 밖 과거 사용"이 보이지 않아 미사용 툴로 둔갑, 거짓 high가 난다.
 */
export function splitByClient(
  input: EngineInput,
): Array<{ client: ClientId; input: EngineInput }> {
  const clients = [...new Set(input.sessions.map((s) => s.client))].sort();
  return clients.map((client) => {
    const ids = new Set(
      input.sessions.filter((s) => s.client === client).map((s) => s.sessionId));
    // serversByClient 맵 자체가 없으면 필터링하지 않는다(undefined = 매핑 정보 없음).
    // 맵은 있는데 이 클라이언트 키가 없으면 그 클라이언트엔 서버가 0개인 것 — 빈 Set으로 취급.
    const allowed = input.serversByClient
      ? (input.serversByClient.get(client) ?? new Set<string>())
      : undefined;
    return {
      client,
      input: {
        // 매핑이 없으면 전량 통과(기존 동작). 매핑이 있으면 그 클라이언트 서버만.
        // 호출·로드는 필터링하지 않는다 — 설정에서 지운 서버의 실사용 이력도 보여야 한다.
        definitions: allowed === undefined
          ? input.definitions
          : input.definitions.filter((d) => allowed.has(d.serverName)),
        calls: input.calls.filter((c) => ids.has(c.sessionId)),
        loads: input.loads.filter((l) => ids.has(l.sessionId)),
        sessions: input.sessions.filter((s) => s.client === client),
        lastCallByTool: input.lastCallByTool,
        serversByClient: input.serversByClient,
      },
    };
  });
}
