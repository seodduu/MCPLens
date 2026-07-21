// packages/core/src/engine/cost.ts
// 누적 비용 산출 — 판정(engine.ts)과 책임이 다르므로 분리한다.
// 설계: docs/superpowers/specs/2026-07-21-매트릭스-누적비용-표시-design.md
// 순수 함수 — 부수효과·파일 IO 없음.
import type { MatrixRow, ToolCallEvent } from '../types.js';

/** 엔진(engine.ts:26)과 동일한 툴 키 형식. 두 곳의 키가 어긋나면 조인이 조용히 실패한다. */
export function toolCostKey(serverName: string, toolName: string): string {
  return `${serverName} ${toolName}`;
}

/**
 * "서버 툴" → 그 툴이 호출된 고유 세션 수.
 * 지연 로딩에서 툴이 호출되려면 정의가 먼저 로드됐어야 하므로,
 * 이 값은 로드 세션 수의 하한이다 (설계문서 v2 3장의 하한 추정 원리).
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

export interface CumulativeCost {
  /** 누적 토큰. 정의 미측정이면 응답분만 담기므로 항상 실제 비용의 하한이다. */
  tokens: number;
  /** false면 정의 토큰 미확보(스캐너 미커버)로 정의분이 빠져 있다. */
  definitionMeasured: boolean;
}

/**
 * 누적 비용 = (정의 토큰 × 유효 로드 세션 수) + 응답 토큰.
 * 유효 로드 세션 수 = max(로드 세션 수, 호출된 고유 세션 수) — 훅만 수집된 세션은
 * 로드 이벤트가 없으므로 호출 사실로 역산한다.
 */
export function cumulativeCost(row: MatrixRow, callSessionCount: number): CumulativeCost {
  const loadSessions = Math.max(row.loadedSessionCount, callSessionCount);
  const defTokens = row.definitionTokens;
  const definitionPart = defTokens != null ? defTokens * loadSessions : 0;
  return {
    tokens: definitionPart + row.responseTokens,
    // 로드된 적이 없으면 정의분은 실제로 0 — 미측정이 아니라 측정된 0이다.
    definitionMeasured: defTokens != null || loadSessions === 0,
  };
}
