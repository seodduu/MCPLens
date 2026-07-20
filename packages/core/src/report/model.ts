// packages/core/src/report/model.ts
// 조치 중심 리포트의 데이터 모델. 집계(rollup)와 렌더링(markdown)의 계약이다.
// 설계: docs/designs/2026-07-20-리포트-가독성-설계.md
import type { ClientId, Recommendation, RecommendationConfidence } from '../types.js';

/**
 * 조치 버킷 — 리포트 정렬의 1차 기준. "정의 토큰 크기"가 아니라
 * "사용자가 지금 무엇을 해야 하는가"로 줄을 세운다.
 */
export type ReportBucket = 'act' | 'candidate' | 'inspect' | 'healthy';

export interface ReportTool {
  toolName: string;
  /** = definitionTokens. 스캐너 미커버면 null */
  perSessionTokens: number | null;
  totalObservedCost: number | null;
  callCount: number;
  errorCount: number;
  errorRate: number | null;
  responseTokens: number;
  lastCalledAt: string | null;
  /** 이 툴만의 꼬리말 (서버 공통이 아닌 것). 없으면 null */
  note: string | null;
}

/**
 * 같은 서버 · 같은 action · 같은 confidence의 툴 묶음 = 사용자가 한 번에 취하는 조치 단위.
 * 서버 공통 근거(headline)와 확신 꼬리말(caveat)이 여기 한 번만 실린다 — 툴 줄에는 반복하지 않는다.
 */
export interface ReportGroup {
  serverName: string;
  action: Recommendation['action'];
  confidence: RecommendationConfidence;
  /** 서버 공통 근거 (reasonParts.serverBasis). 단일 툴 그룹이면 null */
  headline: string | null;
  /** 그룹 대표 꼬리말 (reasonParts.caveat 최빈값) */
  caveat: string | null;
  /** 그룹 내 perSessionTokens 합 (null은 0으로 취급) */
  perSessionTokens: number;
  totalObservedCost: number;
  /** perSessionTokens가 null인 툴이 하나라도 있는가 — 렌더러가 "일부 미측정"을 표시 */
  hasUnmeasured: boolean;
  /** perSessionTokens 내림차순 */
  tools: ReportTool[];
}

export interface ClientReport {
  client: ClientId;
  sessionCount: number;
  /**
   * 관찰 부족으로 클라이언트 전체를 접었는가.
   * act·inspect가 모두 비고 candidate만 있는 상태 = "확정된 조치가 없는데 후보만 잔뜩".
   * 신뢰도가 가장 낮은 섹션이 가장 길어지는 문제(설계 §1 P6)를 여기서 끊는다.
   */
  collapsed: boolean;
  buckets: Record<ReportBucket, ReportGroup[]>;
  /** collapsed일 때만 의미 있음 — 접힌 미사용 정의 요약 */
  collapsedSummary: { toolCount: number; perSessionTokens: number } | null;
  /** visibleMatrixRows가 숨긴 실비용 0 툴 수 */
  hiddenToolCount: number;
  /** action='unknown' (정의 토큰 미확보) 툴 수 — 각주로만 표기 */
  unmeasuredToolCount: number;
}

export interface ReportTotals {
  actPerSessionTokens: number;
  candidatePerSessionTokens: number;
  actServerCount: number;
  actToolCount: number;
  candidateServerCount: number;
  candidateToolCount: number;
  inspectToolCount: number;
  inspectWastedTokens: number;
  healthyToolCount: number;
  healthyResponseTokens: number;
}

export interface ReportModel {
  generatedAt: string;
  days: number;
  /** collapsed=false 우선, 그다음 sessionCount 내림차순 */
  clients: ClientReport[];
  totals: ReportTotals;
}

export interface ReportOptions {
  /** 'summary'면 candidate·healthy 그룹의 툴 목록을 5개로 절단. act·inspect는 절대 절단하지 않는다 */
  detail: 'summary' | 'full';
  /** 헤드라인의 "최근 N일" */
  days: number;
  /** 생성 시각 ISO — 테스트 결정성을 위해 주입받는다 */
  now?: string;
}

/** summary 모드에서 그룹당 표시할 최대 툴 수 */
export const SUMMARY_TOOL_LIMIT = 5;

/** 절단을 적용하지 않는 버킷 — 조치 대상과 점검 대상은 항상 전량 표시한다 */
export const NEVER_TRUNCATED: readonly ReportBucket[] = ['act', 'inspect'];
