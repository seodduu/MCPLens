// packages/core/src/engine/engine.ts
import type { ClientId, LoadPattern, MatrixRow, Recommendation, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../types.js';

export interface EngineInput {
  definitions: ToolDefinition[];
  calls: ToolCallEvent[];
  loads: ToolLoadEvent[];
  sessions: SessionMeta[];
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
    row.recommendation = recommend(row, byServer.get(row.serverName), dominantMode);
  }
  return [...rows.values()].sort(
    (x, y) => (y.definitionTokens ?? 0) - (x.definitionTokens ?? 0));
}

export function sessionSavings(input: EngineInput) {
  const potentialTokens = input.definitions.reduce((s, d) => s + d.definitionTokens, 0);
  const defTokens = new Map(input.definitions.map(
    (d) => [`${d.serverName} ${d.toolName}`, d.definitionTokens]));
  const loadedKeys = new Set(input.loads.map((l) => `${l.serverName ?? ''} ${l.toolName}`));
  let actualTokens = 0;
  for (const k of loadedKeys) actualTokens += defTokens.get(k) ?? 0;
  // Codex처럼 loadedTokens가 직접 기록된 경우는 그 값을 우선
  const direct = input.loads.reduce((s, l) => s + (l.loadedTokens ?? 0), 0);
  actualTokens = Math.max(actualTokens, direct);
  return { potentialTokens, actualTokens, savedTokens: potentialTokens - actualTokens };
}

function baseRow(serverName: string, toolName: string, definitionTokens: number | null): MatrixRow {
  return { serverName, toolName, definitionTokens, callCount: 0, responseTokens: 0,
    loadedSessionCount: 0, sessionCount: 0,
    recommendation: { action: 'unknown', reason: '', evidenceLabel: '측정 불가' },
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
): Recommendation {
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
    if (server && server.total >= 10 && server.used > 0 && server.used / server.total < 0.2)
      return { action: 'filter-server',
        reason: `서버 ${row.serverName}의 ${server.total}툴 중 ${server.used}개만 사용 — 툴 필터링 권장. ${sizePhrase(row.definitionTokens)}${pollutionSuffix}`,
        evidenceLabel };
    return { action: 'remove',
      reason: `정의 ${row.definitionTokens}토큰, 호출 0회 — ${sizePhrase(row.definitionTokens)}${pollutionSuffix}`,
      evidenceLabel };
  }
  if (
    row.callCount >= INSPECT_MIN_CALLS &&
    row.reliability.errorRate != null &&
    row.reliability.errorRate >= INSPECT_ERROR_RATE
  ) {
    const rate = Math.round(row.reliability.errorRate * 100);
    return { action: 'inspect',
      reason: `${row.callCount}회 중 ${row.reliability.errorCount}회 실패(${rate}%), 실패 응답 ${row.reliability.failedResponseTokens}토큰 낭비 — 점검·대체 권장`,
      evidenceLabel };
  }
  if (row.callCount > 0) return { action: 'keep', reason: `${row.callCount}회 호출됨`, evidenceLabel };
  return { action: 'unknown', reason: '정의 토큰 미확보 (스캐너 미커버)', evidenceLabel: '측정 불가' };
}

/**
 * EngineInput을 클라이언트별로 분할한다 (클라이언트별 매트릭스 표시용).
 * definitions는 클라이언트 무관 공유 자원이므로 각 분할에 그대로 포함된다.
 */
export function splitByClient(
  input: EngineInput,
): Array<{ client: ClientId; input: EngineInput }> {
  const clients = [...new Set(input.sessions.map((s) => s.client))].sort();
  return clients.map((client) => {
    const ids = new Set(
      input.sessions.filter((s) => s.client === client).map((s) => s.sessionId));
    return {
      client,
      input: {
        definitions: input.definitions,
        calls: input.calls.filter((c) => ids.has(c.sessionId)),
        loads: input.loads.filter((l) => ids.has(l.sessionId)),
        sessions: input.sessions.filter((s) => s.client === client),
      },
    };
  });
}
