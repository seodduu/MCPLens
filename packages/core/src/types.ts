// packages/core/src/types.ts
export type ClientId = 'claude-code' | 'codex' | 'gemini-cli';
export type ConfigSourceKind = 'claude-user' | 'claude-project' | 'codex' | 'gemini';
export type ServerTransport = 'stdio' | 'http';
export type IdentityConflictState = 'clear' | 'conflict' | 'unreadable';
export type DependencyStatus = 'Independent' | 'Review required' | 'Dependent';
export type InferenceProvider = 'auto' | 'claude' | 'codex';
export type GlobalActionClient = 'claude-code' | 'codex';
export type GlobalActionStatus = 'active' | 'restore-pending' | 'restored' | 'conflict' | 'failed';
export type RegretEvidenceKind = 'direct' | 'indirect';

/** The four accounting modes from design 4-3. */
export type AccountingMode =
  | 'UPFRONT'
  | 'DEFERRED_MEASURABLE'
  | 'DEFERRED_ESTIMATED'
  | 'DEFERRED_OPAQUE';

export interface SessionMeta {
  /** First 16 chars of the sha256 of the absolute file path; must be stable across re-parses. */
  sessionId: string;
  client: ClientId;
  filePath: string | null;
  externalSessionId?: string | null;
  startedAt: string | null; // ISO 8601
  mode: AccountingMode;
}

export interface ToolCallEvent {
  sessionId: string;
  serverName: string; // MCP server name (e.g. 'github')
  toolName: string;   // tool name with the server prefix stripped
  calledAt: string | null;
  durationMs: number | null;
  isError: boolean;
  /** Response tokens the client measured. When absent, responseText is tokenized with tiktoken. */
  responseTokens: number | null;
  responseText: string | null;
  externalCallId?: string | null;
}

/** Evidence that "this definition was loaded into context" in a deferred-loading session. */
export interface ToolLoadEvent {
  sessionId: string;
  serverName: string | null; // Claude records only the name, so this can be null before the scanner join
  toolName: string;
  /** Tokenized directly when the raw load text is recorded (as Codex does), otherwise null (derived by join). */
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

/** Output of one adapter parse; the watcher and backfill ingest this into the store. */
export interface AdapterResult {
  session: SessionMeta;
  toolCalls: ToolCallEvent[];
  toolLoads: ToolLoadEvent[];
  usage: TokenUsageEvent[];
  parseErrors: number;
  toolSearchAttempts?: ToolSearchAttempt[];
}

export interface ToolDefinitionBody {
  serverName: string;
  toolName: string;
  description: string | null;
  inputSchemaJson: string;
  /** Canonical JSON of the tool's outputSchema. null when the server does not publish one. */
  outputSchemaJson: string | null;
  definitionTokens: number;
  definitionSetHash: string;
  scannedAt: string;
}

export interface ServerIdentity {
  client: ClientId;
  serverName: string;
  sourceKind: ConfigSourceKind;
  sourcePathHash: string;
  transport: ServerTransport;
  endpointHash: string;
  conflictState: IdentityConflictState;
  observedAt: string;
}

export interface DependencyCallRecord {
  sequence: number;
  sessionId: string;
  serverName: string;
  toolName: string;
  calledAt: string | null;
  isError: boolean;
}

export interface ToolDependencyResult {
  serverName: string;
  toolName: string;
  status: DependencyStatus;
  dependedOnBy: string[];
  rationale: string;
  displaySummary: string | null;
  whatYouLose: string | null;
  riskWithoutTool: string | null;
}

export interface DependencyAnalysis {
  definitionSetHash: string;
  analysisRulesVersion: number;
  provider: Exclude<InferenceProvider, 'auto'>;
  model: string;
  status: 'complete' | 'failed';
  analyzedAt: string;
  errorCode: string | null;
  /**
   * Distinct sessions observed for this server at the moment of the verdict, within the same
   * 90-day window the call-chain tier uses. 0 means the call-chain tier had nothing to contribute.
   * Read by the reanalysis trigger; never used in a token or savings calculation.
   */
  observedSessionCount: number;
  results: ToolDependencyResult[];
}

/**
 * A tool detected as operating on ambient state rather than on its own inputs.
 * Produced by the state-consumer tier and passed to the LLM tier so it can attribute
 * the producer when no mechanical match exists.
 */
export interface StateConsumerHint {
  toolName: string;
  /** The deictic phrase that triggered detection, e.g. "the current page". Shown in rationale strings. */
  deicticPhrase: string;
}

export interface GlobalAction {
  actionId: string;
  client: GlobalActionClient;
  serverName: string;
  toolName: string;
  identityHash: string;
  definitionSetHash: string;
  ownedRule: string;
  backupPath: string;
  preFingerprint: string;
  postFingerprint: string;
  status: GlobalActionStatus;
  createdAt: string;
  restoredAt: string | null;
}

export interface RegretSignal {
  actionId: string;
  kind: RegretEvidenceKind;
  sessionId: string;
  observedAt: string;
}

export interface ToolSearchAttempt {
  sessionId: string;
  exactToolName: string;
  observedAt: string;
  noMatch: true;
}

export interface InferenceConsent {
  policyVersion: number;
  provider: Exclude<InferenceProvider, 'auto'>;
  model: string;
  status: 'accepted' | 'revoked';
  acceptedAt: string;
  revokedAt: string | null;
}

export interface LogAdapter {
  readonly client: ClientId;
  /** Root directories to watch (absolute paths, may not exist). */
  sessionRoots(): string[];
  /** Whether this file is one of my session files. */
  matches(filePath: string): boolean;
  /** Parses the whole content. Incremental parsing is handled by the watcher slicing content before it calls this. */
  parseFile(filePath: string, content: string): AdapterResult;
}

/** Definition scanner output (the cost axis). */
export interface ToolDefinition {
  serverName: string;
  toolName: string;
  definitionTokens: number;
  scannedAt: string;
  /** When this definition was first observed (ISO). A candidate window start; never overwritten by upsert. */
  firstScannedAt: string;
}

/** Reliability axis (design ch. 7, feature 1 revision). Zero collection cost: reuses the existing is_error/response_tokens. */
export interface ReliabilityStats {
  errorCount: number;
  /** null when callCount is 0 (an uncalled tool cannot be graded for reliability). */
  errorRate: number | null;
  /** Sum of response tokens for failed calls: the size of the "failure chain waste". */
  failedResponseTokens: number;
}

/** Load pattern (inherited from v1), based on tool_loads in DEFERRED sessions. */
export type LoadPattern =
  | 'always-load-candidate'   // loaded in most sessions, so a candidate for alwaysLoad
  | 'search-pollution'        // loaded but never called, so a search-space pollution candidate
  | null;                     // no load records, or undecidable

/** Analysis engine output: one matrix row per tool. */
export interface MatrixRow {
  serverName: string;
  toolName: string;
  definitionTokens: number | null; // null when the scanner does not cover it
  callCount: number;
  responseTokens: number;
  loadedSessionCount: number; // sessions where the definition was loaded, under DEFERRED
  sessionCount: number;       // sessions where this server was connected (approximated by the total session count)
  recommendation: Recommendation;
  reliability: ReliabilityStats;
  loadPattern: LoadPattern;
}

export type RecommendationConfidence = 'high' | 'medium' | 'low';

/** Observation evidence for a recommendation, filled uniformly for every action (lastCalledAt is useful even for keep). */
export interface RecommendationEvidence {
  /** Sessions credited as having observed this tool (including sessions with an unknown startedAt, to avoid undercounting). */
  observedSessions: number;
  /**
   * How many of observedSessions have a valid startedAt confirmed to fall inside the window.
   * Sessions with a null startedAt come along for the whole history, unconstrained by the time
   * window, so high confidence rests on this value alone (observedSessions is left as is and
   * only the grade stays honest).
   */
  datedObservedSessions: number;
  /** Observation window length in days. null when it cannot be computed. */
  observedDays: number | null;
  /** Last call timestamp (ISO). null when there is no call history at all. */
  lastCalledAt: string | null;
  /** Tokens charged per session (= definitionTokens, null when unavailable). */
  costPerSession: number | null;
  /** Accumulated cost over the observation period (= costPerSession x observedSessions). */
  totalObservedCost: number | null;
}

/**
 * The components of the reason prose, decomposed so the report renderer can rearrange them by
 * layer and drop duplicates. Avoiding a copy of the shared server basis on every tool (report
 * readability design §1 P2) is impossible with a single prose string.
 * reason is the join of these pieces and is always equivalent to them.
 */
export interface RecommendationReason {
  /** Basis specific to this tool. e.g. "definition 900 tokens, 0 calls" */
  basis: string;
  /** Shared server-level basis, filled only for filter-server. e.g. "Only 2 of 20 tools used on server notion. Tool filtering recommended." */
  serverBasis: string | null;
  /** Effect of the action. e.g. "about 900 tokens saved per session when removed" | "small savings, but cleans up the search space" */
  effect: string | null;
  /** Body of the confidence caveat (no separator). e.g. "not enough observation (3 sessions/0d), confirmed at 10 sessions" */
  caveat: string | null;
}

export interface Recommendation {
  action: 'remove' | 'filter-server' | 'keep' | 'unknown' | 'inspect';
  /** An axis orthogonal to action: action is "what to do", confidence is "how much to trust it". */
  confidence: RecommendationConfidence;
  /** Mode-aware label: "N tokens saved per session" under upfront, "cleans up the search space" under deferred. */
  reason: string;
  /** Structured decomposition of reason, for the report renderer only. Always equivalent to reason. */
  reasonParts: RecommendationReason;
  evidenceLabel: 'measured' | 'lower-bound estimate' | 'assumed full load' | 'not measurable';
  evidence: RecommendationEvidence;
}
