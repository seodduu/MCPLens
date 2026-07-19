// packages/core/src/types.ts
export type ClientId = 'claude-code' | 'codex' | 'gemini-cli';

/** 설계문서 4-3의 회계 모드 4종 */
export type AccountingMode =
  | 'UPFRONT'
  | 'DEFERRED_MEASURABLE'
  | 'DEFERRED_ESTIMATED'
  | 'DEFERRED_OPAQUE';

export interface SessionMeta {
  /** 파일 절대경로의 sha256 앞 16자리 — 재파싱해도 동일해야 함 */
  sessionId: string;
  client: ClientId;
  filePath: string;
  startedAt: string | null; // ISO 8601
  mode: AccountingMode;
}

export interface ToolCallEvent {
  sessionId: string;
  serverName: string; // MCP 서버 이름 (예: 'github')
  toolName: string;   // 서버 접두어 제거된 툴 이름
  calledAt: string | null;
  durationMs: number | null;
  isError: boolean;
  /** 클라이언트가 기록한 실측 응답 토큰. 없으면 responseText를 tiktoken */
  responseTokens: number | null;
  responseText: string | null;
}

/** 지연 로딩 세션에서 "이 정의가 컨텍스트에 로드됐다"는 증거 */
export interface ToolLoadEvent {
  sessionId: string;
  serverName: string | null; // Claude는 이름만 기록 → 스캐너와 조인 전엔 null 가능
  toolName: string;
  /** Codex처럼 로드 원문이 기록되면 직접 토크나이즈한 값, 아니면 null(조인으로 산출) */
  loadedTokens: number | null;
}

export interface TokenUsageEvent {
  sessionId: string;
  at: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** 어댑터 1회 파싱의 산출물 — 워처·백필이 이것을 저장소에 적재 */
export interface AdapterResult {
  session: SessionMeta;
  toolCalls: ToolCallEvent[];
  toolLoads: ToolLoadEvent[];
  usage: TokenUsageEvent[];
  parseErrors: number;
}

export interface LogAdapter {
  readonly client: ClientId;
  /** 감시 대상 루트 디렉토리들 (절대경로, 존재하지 않을 수 있음) */
  sessionRoots(): string[];
  /** 이 파일이 내 세션 파일인가 */
  matches(filePath: string): boolean;
  /** content 전체를 파싱. 증분 파싱은 워처가 content를 잘라서 넘기는 방식으로 처리 */
  parseFile(filePath: string, content: string): AdapterResult;
}

/** 정의 스캐너 산출물 (비용 축) */
export interface ToolDefinition {
  serverName: string;
  toolName: string;
  definitionTokens: number;
  scannedAt: string;
  /** 이 정의를 처음 관찰한 시각 (ISO). 관찰 창의 시작점 후보 — upsert로 덮이지 않는다 */
  firstScannedAt: string;
}

/** 신뢰도 축 (설계문서 7장 기능 1 개정) — 수집 비용 0: 기존 is_error/response_tokens 재활용 */
export interface ReliabilityStats {
  errorCount: number;
  /** callCount 0이면 null (미호출 툴은 신뢰도 판정 불가) */
  errorRate: number | null;
  /** 실패 호출의 응답 토큰 합 — "실패 체인 낭비" 크기 */
  failedResponseTokens: number;
}

/** 로드 패턴 (v1 계승) — DEFERRED 세션의 tool_loads 기반 */
export type LoadPattern =
  | 'always-load-candidate'   // 세션 대부분에서 로드됨 → alwaysLoad 후보
  | 'search-pollution'        // 로드되지만 호출 0회 → 검색 공간 오염 후보
  | null;                     // 로드 기록 없음 or 판정 불가

/** 분석 엔진 산출물 — 매트릭스 1행 = 툴 1개 */
export interface MatrixRow {
  serverName: string;
  toolName: string;
  definitionTokens: number | null; // 스캐너 미커버 시 null
  callCount: number;
  responseTokens: number;
  loadedSessionCount: number; // DEFERRED에서 정의가 로드된 세션 수
  sessionCount: number;       // 이 서버가 연결돼 있던 세션 수(근사: 전체 세션 수)
  recommendation: Recommendation;
  reliability: ReliabilityStats;
  loadPattern: LoadPattern;
}

export type RecommendationConfidence = 'high' | 'medium' | 'low';

/** 권고의 관찰 근거 — 모든 action에 균일하게 채운다 (keep에서도 lastCalledAt은 유용) */
export interface RecommendationEvidence {
  /** 이 툴을 관찰한 것으로 인정되는 세션 수 */
  observedSessions: number;
  /** 관찰 창 길이 (일). 산정 불가 시 null */
  observedDays: number | null;
  /** 마지막 호출 시각 (ISO). 호출 이력 전무면 null */
  lastCalledAt: string | null;
  /** 세션당 부담 토큰 (= definitionTokens, 미확보 시 null) */
  costPerSession: number | null;
  /** 관찰 기간 누적 부담 (= costPerSession × observedSessions) */
  totalObservedCost: number | null;
}

export interface Recommendation {
  action: 'remove' | 'filter-server' | 'keep' | 'unknown' | 'inspect';
  /** action과 직교하는 축 — action="무엇을 하라", confidence="얼마나 믿을 수 있나" */
  confidence: RecommendationConfidence;
  /** 모드 인지 표기: 업프론트면 "매 세션 N토큰 절약", 지연이면 "검색 공간 정리" */
  reason: string;
  evidenceLabel: '실측' | '하한 추정' | '전량 가정' | '측정 불가';
  evidence: RecommendationEvidence;
}
