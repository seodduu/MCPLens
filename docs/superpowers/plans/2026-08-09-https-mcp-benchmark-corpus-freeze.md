# HTTPS MCP Benchmark Corpus Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** 공개 디렉터리의 원본 근거와 14일 read-only 상태 점검을 재현 가능하게 보존하고, 승인된 선정 규칙을 통과한 HTTPS MCP 서버 30개를 불변 lock 파일로 동결한다.

**Architecture:** 새 `@mcp-lens/benchmark` workspace가 소스 스냅샷 수입, 후보 병합, 공개 점수, 격리된 `initialize`/`tools/list` 점검, 제약식 기반 선정을 담당한다. 공개 산출물은 루트 `benchmark/` 아래 JSON/JSONL/CSV로 두고 JSON Schema와 SHA-256으로 검증한다. 이 단계는 상태 변경 도구를 호출하지 않으며, 생성된 `servers.lock.json`이 다음 단계인 30개 서비스별 setup/read/write/assert/cleanup 구현 계획의 유일한 입력이 된다.

**Tech Stack:** Node.js 20+, TypeScript ESM, npm workspaces, Vitest, `@mcp-lens/core`, MCP TypeScript SDK, Ajv, Node 내장 `crypto`/`child_process`/`fs`.

## Global Constraints

- 기준 설계는 `docs/superpowers/specs/2026-08-09-https-mcp-벤치마크-실험-design.md`다. 수치와 의미가 충돌하면 이 구현 계획을 임의 수정하지 말고 설계 변경 승인을 먼저 받는다.
- 이 단계의 네트워크 호출은 `initialize`와 `tools/list`까지만 허용한다. `tools/call`, 리소스 생성, 메시지 전송, 결제, 배포는 금지한다.
- 실제 사용자 홈과 `~/.mcplens`를 읽거나 수정하지 않는다. 라이브 점검은 저장소 내부 `.benchmark-home/`을 절대 경로로 검증한 뒤 자식 프로세스의 `HOME`에만 주입한다.
- 인증 값은 환경변수 이름만 manifest에 기록한다. 토큰·쿠키·Authorization 헤더·원문 예외 메시지를 결과 파일이나 로그에 쓰지 않는다.
- 단위·통합 테스트는 fixture와 로컬 loopback MCP 서버만 사용한다. 실제 원격 서버 점검과 14일 동결은 마지막 직렬 운영 게이트에서만 실행한다.
- 후보가 부족하거나 네 디렉터리 중 하나의 증거를 합법적이고 재현 가능하게 확보하지 못하면 선정을 완화하지 않고 `BLOCKED` 보고서를 생성한다.
- 실행 중 발견한 기존 사용자 변경은 되돌리지 않는다. 태스크마다 명시된 파일만 수정한다.
- 각 태스크 종료 시 표적 테스트와 해당 package typecheck를 통과시킨다. 최종 게이트에서 `npm test`와 전체 build를 새로 실행한다.

## Scope Boundary and Program Decomposition

이 문서는 전체 벤치마크 프로그램 중 **Gate 1: Corpus Freeze**만 구현한다. 전체 프로그램은 다음 순서로 진행한다.

```text
Gate 1: source evidence + 14-day tools/list health + servers.lock.json
  -> Gate 2: exact 30-service setup/read/write/assert/cleanup adapters
  -> Gate 3: Claude Code/Codex model locks and isolated client runners
  -> Gate 4: 210 task manifests, gold dependency graph, oracle policy
  -> Gate 5: 10,080 future runs and longitudinal regret evaluation
  -> Gate 6: statistics, public result tables, release bundle
```

Gate 2의 정확한 파일 목록과 작업 계약은 Gate 1의 `servers.lock.json`이 생성된 직후 작성한다. 서버가 확정되기 전에 30개 서비스의 OAuth scope, sandbox, 독립 검증 API와 cleanup을 가정하는 것은 재현 가능한 구현 계획이 아니므로 이 문서에는 포함하지 않는다.

Gate 번호는 구현 의존 순서이며 연구 우선순위가 아니다. 최종 공개 평가는 효율성, 안전성, 실제 제품 효과를 동등한 최우선 축으로 유지하고, 세 축 중 하나라도 실행되지 않은 상태에서는 종합 성공을 선언하지 않는다. Gate 1은 모집단을 고정하는 기반 단계일 뿐 MCP Lens의 효과를 주장하는 결과 단계가 아니다.

## Completion Criteria

구현 완료와 코퍼스 동결 완료를 구분한다.

### Implementation complete

- `@mcp-lens/benchmark`가 build되고 모든 fixture/loopback 테스트가 통과한다.
- 네 소스의 raw snapshot과 normalized records를 검증·해시·병합할 수 있다.
- 후보별 점수, 탈락 사유, 14일 probe ledger, 최종 lock을 결정론적으로 만들 수 있다.
- CLI가 실제 사용자 홈을 건드리지 않고 read-only 원격 점검을 수행한다.
- 같은 입력에서 byte-identical `selection.csv`와 `servers.lock.json`이 생성된다.

### Corpus freeze complete

- Official MCP Registry, PulseMCP, Glama, Smithery의 동결일 증거가 모두 저장되어 있다.
- 14개 서로 다른 UTC 날짜의 probe가 있고 각 선정 서버는 12일 이상 성공했다.
- 여섯 도메인에 각 5개, 운영자당 최대 2개, OAuth 최소 15개, API key 최소 5개 조건을 만족한다.
- 모든 선정 서버가 `tools/list` p95 5,000ms 이하, 최신 성공 시 tool 3개 이상, 읽기·되돌릴 수 있는 쓰기·테스트 계정·약관 확인 attestation을 가진다.
- `benchmark/locks/servers.lock.json`, `benchmark/results/selection.csv`, `benchmark/results/corpus-freeze-report.md` 검증이 통과한다.

## Shared Data Contracts

모든 시간은 UTC ISO-8601, 날짜는 `YYYY-MM-DD`, 해시는 소문자 64자리 SHA-256 hex로 저장한다. 출력 JSON은 UTF-8, LF, 키 정렬, 2-space indent, 마지막 newline을 사용한다.

```ts
export const REGISTRY_SOURCE_IDS = [
  "official",
  "pulsemcp",
  "glama",
  "smithery",
] as const;
export type RegistrySourceId = (typeof REGISTRY_SOURCE_IDS)[number];

export const BENCHMARK_DOMAINS = [
  "source-control-developer-tooling",
  "deployment-observability",
  "documents-files-content",
  "productivity-project-management",
  "communication-calendar",
  "data-analytics-commerce-operations",
] as const;
export type BenchmarkDomain = (typeof BENCHMARK_DOMAINS)[number];

export type AuthKind = "oauth" | "api-key" | "open" | "other";

export interface AuthHeaderBinding {
  headerName: string;
  envName: string;
  valueFormat: "raw" | "bearer";
}

export interface SourceRecord {
  sourceRecordId: string;
  displayName: string;
  endpointUrl: string;
  repositoryUrl?: string;
  operatorHint?: string;
  officialEvidenceUrl?: string;
}

export interface SourceSnapshot {
  schemaVersion: 1;
  source: RegistrySourceId;
  sourceUrl: string;
  capturedAt: string;
  rawSha256: string;
  records: SourceRecord[];
}

export interface RepositoryEvidence {
  repositoryUrl: string;
  stars: number;
  pushedAt: string;
  capturedAt: string;
  evidenceUrl: string;
}

export interface ServiceAttestation {
  schemaVersion: 1;
  candidateId: string;
  domain: BenchmarkDomain;
  operatorId: string;
  authKind: AuthKind;
  authEnvNames: string[];
  authHeaderBindings: AuthHeaderBinding[];
  readToolName: string;
  reversibleWriteToolName: string;
  cleanupStrategy: "delete-created-resource" | "restore-snapshot" | "provider-sandbox-reset";
  testAccountAvailable: true;
  automatedTestingAllowed: true;
  termsUrl: string;
  termsCheckedAt: string;
  officialProvider: boolean;
  officialEvidenceUrl?: string;
}

export type ProbeStatus =
  | "ok"
  | "auth-required"
  | "timeout"
  | "transport-error"
  | "protocol-error"
  | "invalid-tool-list"
  | "unknown-error";

export interface ProbeSample {
  schemaVersion: 1;
  candidateId: string;
  observedDate: string;
  attemptedAt: string;
  durationMs: number;
  status: ProbeStatus;
  toolCount: number | null;
  definitionSetHash: string | null;
}
```

`candidateId`는 정규화 endpoint URL의 SHA-256이다. 정규화는 scheme과 host를 소문자로 만들고 기본 `:443`, fragment, 끝 `/`를 제거한다. path와 query는 보존하되 query parameter는 key/value 순으로 정렬한다. embedded credentials, HTTP, 빈 host는 거부한다. `authHeaderBindings`는 secret 값 대신 환경변수 이름과 주입 위치만 저장한다. `oauth`와 `open`은 빈 배열이고, `api-key`/`other`에서 header가 필요하면 각 `envName`은 `authEnvNames`에도 정확히 한 번 나타나야 한다.

## Wave and Dependency Graph

```text
Task 1 contracts/schema/scaffold
  ├─ Task 2 snapshot import
  ├─ Task 3 merge and scoring
  └─ Task 4 probe ledger and isolated launcher
Task 2 + Task 3 + Task 4
  └─ Task 5 constrained selection and lock
Task 5
  ├─ Task 6 CLI composition
  └─ Task 7 public documentation and report
Task 6 + Task 7
  └─ Task 8 local end-to-end verification
Task 8
  └─ Task 9 serial 14-day corpus-freeze operation
```

Tasks 2, 3, 4는 Task 1 이후 파일 소유권이 겹치지 않아 병렬 가능하다. Tasks 5~9는 shared manifest와 실제 원격 서버를 다루므로 순차 실행한다.

---

## Task 1: Benchmark Workspace, Contracts, and Schemas

**Files:**

- Create: `packages/benchmark/package.json`
- Create: `packages/benchmark/tsconfig.json`
- Create: `packages/benchmark/src/contracts.ts`
- Create: `packages/benchmark/src/canonicalJson.ts`
- Create: `packages/benchmark/src/validation.ts`
- Create: `packages/benchmark/src/index.ts`
- Create: `packages/benchmark/test/contracts.test.ts`
- Create: `benchmark/schemas/source-snapshot.schema.json`
- Create: `benchmark/schemas/candidates.schema.json`
- Create: `benchmark/schemas/repository-evidence.schema.json`
- Create: `benchmark/schemas/service-attestation.schema.json`
- Create: `benchmark/schemas/probe-sample.schema.json`
- Create: `benchmark/schemas/server-lock.schema.json`
- Modify: `package-lock.json`

**Interfaces:**

- `normalizeHttpsEndpoint(input: string): string`
- `candidateIdForEndpoint(input: string): string`
- `canonicalJson(value: unknown): string`
- `sha256Hex(bytes: string | Uint8Array): string`
- `createValidator<T>(schema: object): (value: unknown) => T`
- `validateSourceSnapshot`, `validateCandidates`, `validateRepositoryEvidence`, `validateServiceAttestation`, `validateProbeSample`, `validateServerLock`

`@mcp-lens/benchmark` package는 private ESM workspace이며 `@mcp-lens/core`, `ajv`를 dependency로 둔다. build는 `tsc -p tsconfig.json`, bin은 `dist/cli/main.js`의 `mcp-lens-bench`다.

**Steps:**

- [ ] `contracts.test.ts`에 HTTPS 정규화, query 정렬, 기본 port 제거, HTTP/credential 거부, 동일 URL의 안정적 candidate ID, canonical JSON 키 정렬 테스트를 먼저 작성한다.
- [ ] `npm test -- packages/benchmark/test/contracts.test.ts`를 실행해 package와 함수 부재로 실패함을 확인한다.
- [ ] 위 Shared Data Contracts 전체와 endpoint 정규화 함수를 최소 구현한다.
- [ ] JSON Schema 6종에 `additionalProperties: false`, 필수 필드, enum, 형식, SHA 패턴을 명시한다. `candidates.schema.json`은 Task 3의 `ServerCandidate[]`, `server-lock.schema.json`은 Task 5의 `ServerLock` 계약을 미리 포함한다.
- [ ] Ajv validator가 첫 오류의 JSON pointer와 keyword만 반환하고 민감한 값을 메시지에 포함하지 않게 한다.
- [ ] `npm test -- packages/benchmark/test/contracts.test.ts`가 통과하는지 확인한다.
- [ ] `npx tsc --noEmit -p packages/benchmark/tsconfig.json`이 통과하는지 확인한다.
- [ ] `git add packages/benchmark benchmark/schemas package-lock.json && git commit -m "feat(benchmark): add corpus contracts and schemas"`로 커밋한다.

---

## Task 2: Verifiable Source Snapshot Import

**Files:**

- Create: `packages/benchmark/src/registry/snapshot.ts`
- Create: `packages/benchmark/src/registry/snapshotStore.ts`
- Create: `packages/benchmark/test/registry/snapshot.test.ts`
- Create: `packages/benchmark/test/fixtures/registry/official.raw.json`
- Create: `packages/benchmark/test/fixtures/registry/official.records.json`
- Create: `benchmark/sources/README.md`
- Create: `benchmark/sources/.gitkeep`

**Interfaces:**

```ts
export interface ImportSnapshotInput {
  source: RegistrySourceId;
  sourceUrl: string;
  capturedAt: string;
  rawPath: string;
  normalizedRecordsPath: string;
  destinationDirectory: string;
}

export async function importSnapshot(input: ImportSnapshotInput): Promise<{
  snapshotPath: string;
  rawCopyPath: string;
  snapshot: SourceSnapshot;
}>;

export async function loadSnapshots(directory: string): Promise<SourceSnapshot[]>;
```

raw response는 해석하지 않고 byte-for-byte 복사한다. 각 디렉터리마다 사람이 검토 가능한 normalized `SourceRecord[]`를 별도 입력하며 importer가 URL과 중복 ID를 검증한다. 이 방식은 제3자 API response shape가 바뀌어도 원본 근거와 정규화 판단을 분리한다.

**Steps:**

- [ ] fixture raw bytes의 SHA-256, normalized record validation, raw 변조 감지, source/date별 결정론적 파일명 테스트를 먼저 작성한다.
- [ ] `npm test -- packages/benchmark/test/registry/snapshot.test.ts`를 실행해 `importSnapshot`/`loadSnapshots`가 없어 실패함을 확인한다.
- [ ] 파일명 계약을 `{source-id}/{compact-captured-at}-raw.json`과 `{source-id}/{compact-captured-at}-snapshot.json`으로 고정한다. compact 값은 `YYYYMMDDTHHmmssZ`다.
- [ ] destination 경로 탈출을 막고, 같은 snapshot이 이미 있으면 내용이 동일할 때만 성공하는 idempotent write를 구현한다.
- [ ] normalized records를 `sourceRecordId` 오름차순으로 정렬하고 endpoint URL을 canonical form으로 저장한다.
- [ ] `benchmark/sources/README.md`에 네 소스 각각 원본 URL, 수집 시각, 라이선스/약관 확인, 정규화 검토자, raw hash를 남기는 절차를 적는다. 다운로드 방법이 바뀌면 raw URL과 방법을 snapshot metadata로 보존하도록 한다.
- [ ] 표적 테스트와 package typecheck를 통과시킨다.
- [ ] `git add packages/benchmark/src/registry packages/benchmark/test/registry packages/benchmark/test/fixtures benchmark/sources && git commit -m "feat(benchmark): import verifiable registry snapshots"`로 커밋한다.

---

## Task 3: Candidate Merge, Repository Evidence, and Public Score

**Files:**

- Create: `packages/benchmark/src/registry/merge.ts`
- Create: `packages/benchmark/src/registry/repository.ts`
- Create: `packages/benchmark/src/registry/score.ts`
- Create: `packages/benchmark/test/registry/merge.test.ts`
- Create: `packages/benchmark/test/registry/score.test.ts`
- Create: `packages/benchmark/test/fixtures/registry/four-sources.json`

**Interfaces:**

```ts
export interface ServerCandidate {
  candidateId: string;
  endpointUrl: string;
  displayName: string;
  sources: RegistrySourceId[];
  sourceRecords: Array<{
    source: RegistrySourceId;
    sourceRecordId: string;
    displayName: string;
    repositoryUrl?: string;
    operatorHint?: string;
    officialEvidenceUrl?: string;
  }>;
  repositoryUrl?: string;
  operatorHint?: string;
  officialEvidenceUrl?: string;
}

export interface PublicScoreBreakdown {
  directoryPresence: number;
  repositoryInterest: number;
  maintenanceActivity: 0 | 0.5 | 1;
  officialProvider: 0 | 1;
  publicScore: number;
}

export function mergeSnapshots(snapshots: SourceSnapshot[]): ServerCandidate[];
export function scoreCandidates(
  candidates: ServerCandidate[],
  repositoryEvidence: RepositoryEvidence[],
  attestations: ServiceAttestation[],
  freezeDate: string,
): Map<string, PublicScoreBreakdown>;
```

대표 metadata 충돌은 `official > pulsemcp > glama > smithery`, 같은 source 안에서는 `sourceRecordId` 오름차순으로 선택한다. 모든 원래 값은 `sourceRecords`에 보존한다. 한 source snapshot 안에서 같은 canonical endpoint가 여러 record에 있으면 병합하되 source presence는 한 번만 센다.

점수식은 다음과 같이 고정한다.

```text
directoryPresence = distinct source count / 4
repositoryInterest = empirical percentile rank of log10(stars + 1)
maintenanceActivity = 1 when pushedAt age <= 90 days,
                      0.5 when age <= 365 days,
                      otherwise 0
officialProvider = attestation.officialProvider ? 1 : 0
publicScore = 0.35*directoryPresence
            + 0.25*repositoryInterest
            + 0.20*maintenanceActivity
            + 0.20*officialProvider
```

동률 percentile은 `(count strictly lower + 0.5 * count equal) / candidate count with repository evidence`로 계산한다. 저장소 증거가 없는 후보의 repositoryInterest는 0이다. 내부 계산은 JavaScript double을 유지하고 CSV 표시 시에만 소수점 6자리로 반올림한다.

**Steps:**

- [ ] 같은 endpoint가 네 source에서 병합되는 경우, 서로 다른 path/query는 분리되는 경우, 충돌하는 repository/operator hint를 provenance와 함께 보존하는 테스트를 먼저 작성한다.
- [ ] 점수의 0/90/91/365/366일 경계, tie percentile, repository missing, exact weighted sum 테스트를 먼저 작성한다.
- [ ] `npm test -- packages/benchmark/test/registry/merge.test.ts packages/benchmark/test/registry/score.test.ts`를 실행해 merge/score 함수가 없어 실패함을 확인한다.
- [ ] merge 결과를 `publicScore desc, candidateId asc`로 결정론적 정렬한다.
- [ ] repository evidence를 normalized repository URL로 연결하고 중복·음수 stars·미래 pushedAt을 거부한다.
- [ ] freezeDate를 UTC date로 검증하고 경과 일수는 calendar-day 차이로 계산한다.
- [ ] 두 표적 테스트와 package typecheck를 통과시킨다.
- [ ] `git add packages/benchmark/src/registry packages/benchmark/test/registry packages/benchmark/test/fixtures && git commit -m "feat(benchmark): score public server candidates"`로 커밋한다.

---

## Task 4: Read-only Probe Ledger and Isolated HOME Launcher

**Files:**

- Create: `packages/benchmark/src/probe/classifyError.ts`
- Create: `packages/benchmark/src/probe/probeCandidate.ts`
- Create: `packages/benchmark/src/probe/ledger.ts`
- Create: `packages/benchmark/src/probe/isolatedLauncher.ts`
- Create: `packages/benchmark/src/cli/internalProbe.ts`
- Create: `packages/benchmark/src/cli/internalAuth.ts`
- Create: `packages/benchmark/test/probe/probeCandidate.test.ts`
- Create: `packages/benchmark/test/probe/ledger.test.ts`
- Create: `packages/benchmark/test/probe/isolatedLauncher.test.ts`
- Modify: `.gitignore`

**Interfaces:**

```ts
export type ScanFunction = (
  spec: import("@mcp-lens/core").McpServerSpec,
  timeoutMs?: number,
) => ReturnType<typeof import("@mcp-lens/core").scanServer>;

export async function probeCandidate(input: {
  candidate: ServerCandidate;
  observedDate: string;
  attemptedAt: string;
  timeoutMs: 15000;
  scan?: ScanFunction;
}): Promise<ProbeSample>;

export async function appendProbeSample(
  ledgerPath: string,
  sample: ProbeSample,
): Promise<void>;

export async function launchIsolatedProbe(input: {
  homeDirectory: string;
  candidateFile: string;
  observedDate: string;
}): Promise<ProbeSample>;

export async function launchIsolatedOAuthLogin(input: {
  homeDirectory: string;
  candidateFile: string;
}): Promise<void>;
```

`probeCandidate`는 core `scanServer`를 주입 기본값으로 사용한다. 성공 시 definitions를 tool name 오름차순으로 canonical JSON 처리하여 `definitionSetHash`를 만든다. 실패 시 status만 분류하고 원문 예외를 폐기한다.

**Steps:**

- [ ] injected scan 성공, timeout, 401/403 auth, transport, protocol, invalid tool list, unknown error를 각각 ProbeSample로 변환하는 테스트를 먼저 작성한다.
- [ ] 같은 `(candidateId, observedDate)`의 동일 sample 재기록은 no-op, 다른 sample은 conflict인 ledger 테스트를 먼저 작성한다.
- [ ] launcher가 상대 `--home`, 저장소 밖 home, 실제 process HOME과 동일한 home을 거부하고, 자식 env에서만 HOME을 바꾸며 attestation의 `authEnvNames`만 allowlist로 전달하는 테스트를 작성한다.
- [ ] `npm test -- packages/benchmark/test/probe/probeCandidate.test.ts packages/benchmark/test/probe/ledger.test.ts packages/benchmark/test/probe/isolatedLauncher.test.ts`를 실행해 probe/ledger/launcher 구현이 없어 실패함을 확인한다.
- [ ] ledger를 candidate별 JSONL로 저장하고 temp file + rename으로 원자적 갱신한다. 줄은 observedDate 오름차순이다.
- [ ] `.gitignore`에 `/.benchmark-home/`, `/benchmark/inbox/`, `/benchmark/private/`를 추가한다. `benchmark/sources`, `benchmark/probes`, `benchmark/results`, `benchmark/locks`는 ignore하지 않는다.
- [ ] `internalProbe`는 공개 CLI에서 직접 노출하지 않고 parent가 만든 nonce-bearing request file만 받게 한다. request file mode가 POSIX `0600`이 아니면 거부한다.
- [ ] API key binding은 자식 내부에서만 `McpServerSpec.headers`로 변환한다. `raw`는 환경변수 값을 그대로, `bearer`는 `Bearer ` prefix를 붙인다. 누락 env, CR/LF 포함 값, 중복 header는 probe 전에 거부한다.
- [ ] OAuth login 자식은 격리 HOME의 `.mcplens/oauth`를 명시적 `baseDir`로 `authenticateServer`에 전달하고 브라우저 URL을 연다. probe 자식은 같은 HOME에서 `scanServer`가 저장 토큰을 읽게 한다.
- [ ] probe child process는 `stdio: ["ignore", "pipe", "pipe"]`로 실행하고 stdout의 단일 validated ProbeSample만 수용한다. stderr에는 candidateId와 분류된 status만 허용한다.
- [ ] 표적 테스트와 package typecheck를 통과시킨다.
- [ ] `git add packages/benchmark/src/probe packages/benchmark/src/cli/internalProbe.ts packages/benchmark/src/cli/internalAuth.ts packages/benchmark/test/probe .gitignore && git commit -m "feat(benchmark): add isolated read-only health probes"`로 커밋한다.

---

## Task 5: Eligibility, Constrained Selection, and Immutable Lock

**Files:**

- Create: `packages/benchmark/src/selection/health.ts`
- Create: `packages/benchmark/src/selection/select.ts`
- Create: `packages/benchmark/src/selection/lock.ts`
- Create: `packages/benchmark/src/selection/csv.ts`
- Create: `packages/benchmark/test/selection/health.test.ts`
- Create: `packages/benchmark/test/selection/select.test.ts`
- Create: `packages/benchmark/test/selection/lock.test.ts`
- Create: `packages/benchmark/test/fixtures/selection/eligible-36.json`
- Create: `packages/benchmark/test/fixtures/selection/insufficient-auth.json`
- Create: `benchmark/attestations/.gitkeep`
- Create: `benchmark/probes/.gitkeep`
- Create: `benchmark/results/.gitkeep`
- Create: `benchmark/locks/.gitkeep`

**Interfaces:**

```ts
export interface HealthSummary {
  distinctDays: number;
  successDays: number;
  p95DurationMs: number | null;
  latestToolCount: number | null;
  definitionDriftCount: number;
  eligible: boolean;
  reasons: string[];
}

export interface SelectionRow {
  candidate: ServerCandidate;
  score: PublicScoreBreakdown;
  health: HealthSummary;
  attestation?: ServiceAttestation;
  selected: boolean;
  selectionRank: number | null;
  reasons: string[];
}

export interface ServerLockEntry {
  candidateId: string;
  displayName: string;
  endpointUrl: string;
  operatorId: string;
  domain: BenchmarkDomain;
  authKind: AuthKind;
  authEnvNames: string[];
  authHeaderBindings: AuthHeaderBinding[];
  readToolName: string;
  reversibleWriteToolName: string;
  cleanupStrategy: ServiceAttestation["cleanupStrategy"];
  publicScore: PublicScoreBreakdown;
  sourceSnapshotHashes: Partial<Record<RegistrySourceId, string>>;
  probeLedgerHash: string;
  attestationHash: string;
}

export interface ServerLock {
  schemaVersion: 1;
  benchmarkId: "mcplens-https-mcp-30";
  frozenAt: string;
  selectionAlgorithm: "domain-auth-constraints-v1";
  designDocumentHash: string;
  entries: ServerLockEntry[];
}

export function summarizeHealth(samples: ProbeSample[]): HealthSummary;
export function selectCorpus(rows: Omit<SelectionRow, "selected" | "selectionRank" | "reasons">[]): SelectionRow[];
export function buildServerLock(input: BuildServerLockInput): ServerLock;
export function verifyServerLock(lock: ServerLock, evidenceRoot: string): Promise<void>;
```

Health 계산은 14개의 서로 다른 UTC 날짜를 요구하고 `ok`가 12개 이상이어야 한다. p95는 성공 duration 오름차순에서 `ceil(0.95*n)-1` index의 nearest-rank다. 최신 성공 sample의 toolCount가 3 이상이어야 한다. definition drift는 보고만 하고 eligibility를 자동 탈락시키지 않는다.

선정은 전역 branch-and-bound 제약식 탐색으로 구현한다. 각 도메인 정확히 5개, 운영자 최대 2개, OAuth 최소 15개, API key 최소 5개를 동시에 만족하는 모든 조합 중 `(총 publicScore, 정렬된 candidateId 목록의 역 lexicographic 우선순위)`가 최대인 조합을 택한다. 후보를 자르지 않으며, 남은 후보 점수의 낙관적 상한과 남은 auth quota의 충족 가능성으로만 branch를 제거한다. feasible 조합이 없으면 `selection-constraints-unsatisfied`로 종료하며 기준을 완화하지 않는다.

**Steps:**

- [ ] health의 11/12 성공 경계, 13일/14일 경계, exact p95, latest success tool count, duplicate date 거부 테스트를 먼저 작성한다.
- [ ] fixture 36개에서 정확히 30개, 도메인 5개씩, operator cap, auth minimum, score 최적 조합과 결정론적 tie-break를 단언하는 테스트를 작성한다.
- [ ] auth 또는 operator 제약이 불가능한 fixture에서 명시적 실패와 진단 counts를 단언한다.
- [ ] lock을 생성한 뒤 evidence 한 byte를 바꾸면 hash 검증이 실패하고, 입력 순서를 뒤섞어도 lock bytes가 동일한 테스트를 작성한다.
- [ ] `npm test -- packages/benchmark/test/selection/health.test.ts packages/benchmark/test/selection/select.test.ts packages/benchmark/test/selection/lock.test.ts`를 실행해 health/selection/lock 구현이 없어 실패함을 확인한다.
- [ ] 탈락 이유 enum을 `missing-attestation`, `insufficient-days`, `insufficient-success-days`, `p95-too-high`, `too-few-tools`, `invalid-attestation`, `not-selected-by-score`, `operator-cap`, `auth-quota`, `domain-quota`로 고정한다.
- [ ] `selection.csv` column 순서를 `candidate_id,display_name,endpoint_url,domain,operator_id,auth_kind,public_score,directory_presence,repository_interest,maintenance_activity,official_provider,distinct_days,success_days,p95_ms,latest_tool_count,selected,selection_rank,reasons`로 고정한다.
- [ ] lock entries를 `domain enum order, selectionRank` 순으로 저장하고 design document, source snapshots, attestation, ledger의 content hash를 포함한다.
- [ ] 표적 테스트와 package typecheck를 통과시킨다.
- [ ] `git add packages/benchmark/src/selection packages/benchmark/test/selection packages/benchmark/test/fixtures/selection benchmark/attestations benchmark/probes benchmark/results benchmark/locks && git commit -m "feat(benchmark): freeze constrained server corpus"`로 커밋한다.

---

## Task 6: Compose the Public CLI

**Files:**

- Create: `packages/benchmark/src/cli/args.ts`
- Create: `packages/benchmark/src/cli/main.ts`
- Create: `packages/benchmark/src/cli/commands/importSnapshot.ts`
- Create: `packages/benchmark/src/cli/commands/authLogin.ts`
- Create: `packages/benchmark/src/cli/commands/buildCandidates.ts`
- Create: `packages/benchmark/src/cli/commands/probeAll.ts`
- Create: `packages/benchmark/src/cli/commands/select.ts`
- Create: `packages/benchmark/src/cli/commands/verify.ts`
- Create: `packages/benchmark/test/cli/args.test.ts`
- Create: `packages/benchmark/test/cli/main.test.ts`
- Modify: `packages/benchmark/src/index.ts`

**CLI contract:**

```text
mcp-lens-bench snapshot import \
  --source official \
  --source-url https://registry.modelcontextprotocol.io/v0.1/servers \
  --captured-at 2026-08-09T00:00:00Z \
  --raw benchmark/inbox/official.raw.json \
  --records benchmark/inbox/official.records.json

mcp-lens-bench corpus candidates

mcp-lens-bench probe all \
  --home .benchmark-home \
  --candidates benchmark/results/candidates.json \
  --attestations benchmark/attestations

mcp-lens-bench auth login \
  --home .benchmark-home \
  --candidate-id 844f2c855f2a890c4f517f30eaed0dd310f0576846871999cee1c8132df8f822

mcp-lens-bench corpus select --freeze-now
mcp-lens-bench corpus verify
```

위 timestamp는 parser fixture의 고정 예시이며 라이브 `snapshot import`에서는 실제 수집 시각을 RFC3339로 입력한다. `probe all`의 observedDate 기본값은 현재 UTC date이며 같은 날짜 재실행은 idempotent하다.

**Steps:**

- [ ] unknown command/flag, missing required flag, invalid enum/date/path, `--help`, exit code 0/1/2 테스트를 먼저 작성한다. usage error는 2, 검증·운영 실패는 1이다. 위 candidate ID는 parser fixture의 고정값이다.
- [ ] temp fixture repository에서 snapshot import → candidates → fake probe → select → verify가 이어지는 CLI 통합 테스트를 먼저 작성한다.
- [ ] `npm test -- packages/benchmark/test/cli/args.test.ts packages/benchmark/test/cli/main.test.ts`를 실행해 command dispatcher가 없어 실패함을 확인한다.
- [ ] args parser는 dependency를 추가하지 않고 명시적 subcommand table로 구현한다. secret 값 flag는 제공하지 않는다.
- [ ] 모든 command에 `--json`을 지원한다. 기본 stdout은 최종 요약만 출력하고 진행 정보는 stderr로 보낸다.
- [ ] `probe all`은 후보를 `candidateId` 순으로 직렬 실행하며 서버당 한 번만 연결한다. rate limit과 외부 영향 최소화를 위해 concurrency option을 제공하지 않는다.
- [ ] `corpus candidates`는 네 source가 정확히 한 snapshot씩 있는지 검증하고 merge 결과를 `candidateId` 순으로 `benchmark/results/candidates.json`에 canonical write한다. source가 없거나 둘 이상이면 선택할 파일을 추측하지 않고 실패한다.
- [ ] `corpus select`는 네 source가 정확히 한 동결 snapshot씩 있는지, attestations와 probe ledgers가 hash-valid인지 먼저 확인한다.
- [ ] `corpus verify`는 네트워크를 사용하지 않고 공개 파일만으로 schema, hash, quota, score, health를 재계산한다.
- [ ] 표적 테스트, package typecheck, `npm run build -w @mcp-lens/benchmark`를 통과시킨다.
- [ ] `git add packages/benchmark/src/cli packages/benchmark/test/cli packages/benchmark/src/index.ts && git commit -m "feat(benchmark): expose corpus freeze CLI"`로 커밋한다.

---

## Task 7: Public Methodology, Attestation Template, and Freeze Report

**Files:**

- Create: `benchmark/README.md`
- Create: `benchmark/methodology/corpus-selection.md`
- Create: `benchmark/templates/service-attestation.example.json`
- Create: `benchmark/templates/source-records.example.json`
- Create: `packages/benchmark/src/report/freezeReport.ts`
- Create: `packages/benchmark/test/report/freezeReport.test.ts`

**Report contract:**

`corpus-freeze-report.md`는 다음 순서와 필드를 고정한다.

1. freeze timestamp와 design hash
2. source별 URL, capturedAt, raw SHA-256, record count
3. 후보 수 → attested 수 → health eligible 수 → selected 30 funnel
4. 도메인·인증·운영자 분포
5. success-day, p95, tool-count 분포
6. 선정 30개 표
7. 탈락 이유별 count
8. definition drift와 운영상 경고
9. Gate 2 시작 조건과 금지된 주장

금지된 표현은 `most used`, `top 30 by users`, `market share`다. 허용 표현은 `commonly discoverable live remote MCP servers selected by a public reproducible score`다.

**Steps:**

- [ ] 고정 fixture로 report snapshot 테스트를 먼저 작성한다. URL과 hash가 포함되고 금지 표현이 없는지 단언한다.
- [ ] `npm test -- packages/benchmark/test/report/freezeReport.test.ts`를 실행해 report generator가 없어 실패함을 확인한다.
- [ ] report generator는 SelectionRow와 ServerLock만 입력받고 네트워크·현재 시각을 직접 읽지 않게 구현한다.
- [ ] `service-attestation.example.json`을 schema-valid 값으로 작성하고, tool 이름은 `example_read`/`example_create`, cleanup은 `delete-created-resource`, terms URL은 `https://example.com/terms`, evidence URL은 `https://example.com/docs/mcp`를 사용한다.
- [ ] methodology에 점수식, percentile, p95, 제약 최적화, 운영자 cap, auth quota, 14일 규칙, 교체 금지, blocked 정책을 수식과 함께 적는다.
- [ ] README에 민감정보 금지, 전용 계정, read-only Gate 1, Gate 2에서만 쓰기 호출한다는 경계를 강조한다.
- [ ] 표적 테스트와 package typecheck를 통과시킨다.
- [ ] `git add benchmark/README.md benchmark/methodology benchmark/templates packages/benchmark/src/report packages/benchmark/test/report && git commit -m "docs(benchmark): document reproducible corpus freeze"`로 커밋한다.

---

## Task 8: Local End-to-End and Full Regression Gate

**Files:**

- Create: `packages/benchmark/test/e2e/corpus-freeze.test.ts`
- Create: `packages/benchmark/test/support/loopbackMcp.ts`
- Modify only if required by a discovered integration defect: files created in Tasks 1–7

**Steps:**

- [ ] 로컬 loopback Streamable HTTP MCP 36개를 나타내는 fixture를 만든다. 실제 listen socket은 3개만 띄우고 candidate별 응답 fixture를 multiplex하여 테스트 시간을 제한한다.
- [ ] `npm test -- packages/benchmark/test/e2e/corpus-freeze.test.ts`를 실행해 loopback 지원과 전체 CLI orchestration이 아직 연결되지 않아 실패함을 확인한다.
- [ ] 14일 중 12일 성공, 느린 p95, tool 2개, auth 실패, definition drift 사례를 포함한다.
- [ ] 네 source import부터 `servers.lock.json`, `selection.csv`, report 생성과 offline verify까지 public CLI만으로 실행한다.
- [ ] 자식 HOME 안에만 `.mcplens`가 생기고 test process 원래 HOME에는 파일이 생성되지 않았음을 단언한다.
- [ ] 같은 fixture를 두 temp directory에서 실행해 lock, CSV, report bytes가 동일함을 단언한다. report의 frozenAt은 fixture 입력값을 사용한다.
- [ ] `npm test -- packages/benchmark/test/e2e/corpus-freeze.test.ts`를 통과시킨다.
- [ ] `npx tsc --noEmit -p packages/benchmark/tsconfig.json`을 통과시킨다.
- [ ] `npm run build`를 통과시킨다.
- [ ] `npm test` 전체 회귀를 통과시킨다.
- [ ] `git diff --check`를 통과시킨다.
- [ ] `git add packages/benchmark/test/e2e packages/benchmark/test/support && git commit -m "test(benchmark): verify corpus freeze end to end"`로 커밋한다.

---

## Task 9: Serial Live 14-Day Corpus Freeze Operation

이 태스크는 구현 커밋과 분리된 운영 게이트다. 네트워크, OAuth/API key, 제3자 약관이 필요하므로 단일 작업자가 직렬로 실행한다. source 원본과 공개 결과만 커밋하며 `.benchmark-home`, `benchmark/inbox`, `benchmark/private`는 절대 커밋하지 않는다.

**Files:**

- Create with CLI: `benchmark/sources/official/*-raw.json`, `benchmark/sources/pulsemcp/*-raw.json`, `benchmark/sources/glama/*-raw.json`, `benchmark/sources/smithery/*-raw.json`
- Create with CLI: `benchmark/sources/official/*-snapshot.json`, `benchmark/sources/pulsemcp/*-snapshot.json`, `benchmark/sources/glama/*-snapshot.json`, `benchmark/sources/smithery/*-snapshot.json`
- Create from reviewed evidence: `benchmark/repositories/evidence.json`
- Create from reviewed attestations: `benchmark/attestations/*.json`
- Create with CLI over 14 days: `benchmark/probes/*.jsonl`
- Create with CLI: `benchmark/results/candidates.json`
- Create with CLI: `benchmark/results/selection.csv`
- Create with CLI: `benchmark/results/corpus-freeze-report.md`
- Create with CLI: `benchmark/locks/servers.lock.json`

**Day 0 source and attestation steps:**

- [ ] 네 디렉터리에서 원본 export/API response를 각각 한 번 수집해 `benchmark/inbox`에 둔다. 접근에 계정이 필요하면 전용 benchmark 계정을 사용하고 API token은 환경변수로만 제공한다.
- [ ] 각 원본에서 endpoint, repository, operator, official evidence를 `SourceRecord[]`로 수동 검토해 records 파일을 만든다. 두 번째 검토자가 endpoint와 provenance를 대조한다.
- [ ] 네 source마다 `snapshot import`를 실행한다. 하나라도 확보 실패, 약관 불명확, raw hash 불일치이면 `BLOCKED`로 중단한다.
- [ ] `npm run build -w @mcp-lens/benchmark`를 실행한다.
- [ ] `node packages/benchmark/dist/cli/main.js corpus candidates`를 실행해 `benchmark/results/candidates.json`을 만든다.
- [ ] GitHub 공개 저장소 증거를 동결일 기준으로 저장한다. stars, pushedAt, capturedAt, evidence URL을 repository schema로 검증한다.
- [ ] 후보별 서비스 약관, 테스트 계정/sandbox, 최소권한 인증, 읽기 tool, 되돌릴 수 있는 쓰기 tool과 cleanup strategy를 확인해 attestation을 작성한다. 실제 쓰기 tool은 아직 호출하지 않는다.
- [ ] OAuth 후보는 `auth login --home .benchmark-home --candidate-id`로 전용 계정에 로그인한다. API key 후보는 attestation의 `authHeaderBindings`와 이름이 일치하는 환경변수를 현재 셸에만 제공한다.
- [ ] candidate count와 source별 merge count를 검토한다.

**Daily Days 1–14:**

- [ ] 매일 한 번 저장소 루트에서 `node packages/benchmark/dist/cli/main.js probe all --home .benchmark-home --candidates benchmark/results/candidates.json --attestations benchmark/attestations`를 실행한다.
- [ ] 실행 후 당일 ledger가 후보당 최대 1개인지, raw error/secret이 없는지 `corpus verify --pre-freeze`로 확인한다.
- [ ] 실패 서버를 같은 날 반복 호출해 성공률을 인위적으로 올리지 않는다. 네트워크 전체 장애는 incident log에 기록하되 sample을 삭제하지 않는다.
- [ ] cleanup이나 상태 변경은 수행하지 않는다. 이 단계에서 tool call이 관측되면 즉시 중단하고 원인을 조사한다.

**Freeze Day:**

- [ ] 14개 distinct UTC dates와 네 source hash를 offline verify한다.
- [ ] `node packages/benchmark/dist/cli/main.js corpus select --freeze-now`를 실행한다.
- [ ] `node packages/benchmark/dist/cli/main.js corpus verify`를 clean environment에서 다시 실행한다.
- [ ] 선정 수 30, 도메인별 5, operator 최대 2, OAuth 15 이상, API key 5 이상을 report와 machine validation 양쪽에서 확인한다.
- [ ] 제약을 만족하지 못하면 후보를 임의 교체하거나 기준을 낮추지 않는다. `benchmark/results/corpus-freeze-blocked.md`에 부족한 도메인/auth/health count를 기록한다.
- [ ] 성공 시 공개 source, evidence, attestations, ledgers, results, lock만 stage하고 `git diff --cached --check`를 실행한다.
- [ ] `git commit -m "data(benchmark): freeze 30-server HTTPS MCP corpus"`로 동결 데이터를 커밋한다.

**Gate 2 handoff:**

- [ ] `servers.lock.json`의 30개 entry를 입력으로 서비스별 exact adapter matrix를 생성한다.
- [ ] 각 서버에 실제 OAuth scope, setup API, R1/W1/D1/D2/S1/H1, independent assert, idempotent cleanup, kill switch를 조사한다.
- [ ] 그 조사 결과로 `docs/superpowers/plans/https-mcp-service-adapters.md`를 작성하고 사용자 승인을 받은 뒤에만 실제 `tools/call` 구현을 시작한다.

## Final Verification Checklist

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npx tsc --noEmit -p packages/benchmark/tsconfig.json`
- [ ] `git diff --check`
- [ ] `node packages/benchmark/dist/cli/main.js corpus verify`
- [ ] 실제 사용자 `~/.mcplens`와 Claude/Codex MCP 설정의 mtime이 실행 전후 동일함을 확인
- [ ] tracked 파일에 token, cookie, Authorization header, private test data가 없는지 secret scan
- [ ] `servers.lock.json`이 정확히 30개이고 모든 referenced hash가 현재 파일과 일치

## Failure Reporting Contract

작업자가 안전하게 계속할 수 없는 경우 `BLOCKED`로 끝내고 다음 네 항목을 남긴다.

1. 실패한 Task/Gate와 정확한 명령
2. exit code와 비밀을 제거한 오류 분류
3. 이미 생성된 공개 산출물과 검증 상태
4. 기준 완화 없이 재개하기 위해 필요한 외부 입력 또는 승인

네 소스 미확보, 약관상 자동 점검 금지, 테스트 계정 부재, quota 미충족, 실제 사용자 홈 접근 감지는 모두 즉시 중단 조건이다.
