// packages/core/src/engine/engine.ts
import type { MatrixRow, Recommendation, SessionMeta, ToolCallEvent,
  ToolDefinition, ToolLoadEvent } from '../types.js';

export interface EngineInput {
  definitions: ToolDefinition[];
  calls: ToolCallEvent[];
  loads: ToolLoadEvent[];
  sessions: SessionMeta[];
}

export function buildMatrix(input: EngineInput): MatrixRow[] {
  const { definitions, calls, loads, sessions } = input;
  const key = (s: string, t: string) => `${s} ${t}`;

  const callAgg = new Map<string, { n: number; tokens: number }>();
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    const a = callAgg.get(k) ?? { n: 0, tokens: 0 };
    a.n++; a.tokens += c.responseTokens ?? 0;
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

  // 정의된 툴 + 정의 없이 호출만 된 툴의 합집합
  const rows = new Map<string, MatrixRow>();
  for (const d of definitions) rows.set(key(d.serverName, d.toolName), baseRow(d.serverName, d.toolName, d.definitionTokens));
  for (const c of calls) {
    const k = key(c.serverName, c.toolName);
    if (!rows.has(k)) rows.set(k, baseRow(c.serverName, c.toolName, null));
  }

  for (const [k, row] of rows) {
    const a = callAgg.get(k);
    row.callCount = a?.n ?? 0;
    row.responseTokens = a?.tokens ?? 0;
    row.loadedSessionCount = loadSessions.get(k)?.size ?? 0;
    row.sessionCount = sessions.length;
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
    recommendation: { action: 'unknown', reason: '', evidenceLabel: '측정 불가' } };
}

function pickDominantMode(sessions: SessionMeta[]): SessionMeta['mode'] {
  const counts = new Map<SessionMeta['mode'], number>();
  for (const s of sessions) counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
  let best: SessionMeta['mode'] = 'DEFERRED_OPAQUE', n = -1;
  for (const [m, c] of counts) if (c > n) { best = m; n = c; }
  return best;
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

  if (row.callCount === 0 && row.definitionTokens != null) {
    if (server && server.total >= 10 && server.used > 0 && server.used / server.total < 0.2)
      return { action: 'filter-server',
        reason: `서버 ${row.serverName}의 ${server.total}툴 중 ${server.used}개만 사용 — 툴 필터링 권장. ${sizePhrase(row.definitionTokens)}`,
        evidenceLabel };
    return { action: 'remove',
      reason: `정의 ${row.definitionTokens}토큰, 호출 0회 — ${sizePhrase(row.definitionTokens)}`,
      evidenceLabel };
  }
  if (row.callCount > 0) return { action: 'keep', reason: `${row.callCount}회 호출됨`, evidenceLabel };
  return { action: 'unknown', reason: '정의 토큰 미확보 (스캐너 미커버)', evidenceLabel: '측정 불가' };
}
