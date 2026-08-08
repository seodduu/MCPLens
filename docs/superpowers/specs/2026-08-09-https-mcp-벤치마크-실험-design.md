# HTTPS MCP 30종 공개 벤치마크 실험 설계 (2026-08-09)

## 문서 지위

- 상태: 사용자 승인 후 작성된 실험 설계 사양
- 대상: MCP Lens의 비용 회계, 사용량 판정, 방향성 의존 판정, 가역 비활성화와 regret 회수 루프
- 공개 형태: GitHub에서 데이터·하네스·실행 기록을 재현할 수 있는 공개 벤치마크
- 실행 클라이언트: Claude Code와 Codex
- 제외 클라이언트: Gemini CLI

이 문서는 구현 계획이 아니다. 벤치마크가 무엇을 주장하고 어떤 데이터와 통계로 그 주장을
검증하는지를 고정한다. 구현 파일 분해, Wave, worktree와 실행 프롬프트는 이 문서가 승인된 뒤
별도 구현 계획에서 정한다.

## 1. 목적

실제 Streamable HTTP(S) MCP 서버 30개를 Claude Code와 Codex에서 읽기·쓰기까지 호출해 다음
세 질문에 동등한 우선순위로 답한다.

1. **효율성**: MCP Lens가 실제 입력·검색 토큰, 실행 비용과 지연을 얼마나 줄이는가?
2. **안전성**: 다른 툴이 의존하는 툴을 `Safe to disable`로 잘못 판정하지 않는가?
3. **제품 효과**: 비활성화 후에도 미래 작업 성공률을 보존하고, 다시 필요한 툴을 감지해
   복구하는가?

벤치마크의 대표 문장은 `서버 수와 실행 수 → All-on/MCPLens 작업 성공률 → 실제 입력 비용
감소율 → 부수적 실패율 → 중앙값 손익분기 세션` 순서로 쓴다. 각 값은 실험 결과로만 채우며
정의 토큰 추정치를 실제 청구 절감으로 표현하지 않는다.

## 2. 핵심 원칙

### 2-1. 하나의 종합점수를 만들지 않는다

효율성, 안전성, 제품 효과는 서로 대체할 수 없다. 비용을 많이 줄여도 작업을 깨뜨리면 실패이고,
안전해도 실제 절감이 없으면 사용 가치가 약하다. 결과는 세 축과 Pareto 그래프로 공개한다.

### 2-2. 30개는 말뭉치이지 일반 사용자의 단일 설정이 아니다

일반 사용자는 30개 서버를 동시에 연결하지 않을 수 있다. 실제 효과는 사용자 프로필별 6~15개
서버 번들에서 측정하고, 30개 동시 연결은 별도 스트레스 트랙으로만 사용한다.

### 2-3. 실제 원격 서버와 실제 상태 변경을 사용한다

`tools/list`만 스캔하는 실험으로 제품 효과를 주장하지 않는다. 전용 테스트 계정·테넌트에서 실제
`tools/call`을 실행하고, 쓰기 결과를 독립 검증한 뒤 원상복구한다. 결제·배포·메시지 전송처럼 외부
영향이 있는 작업은 제공자의 sandbox/test mode, 테스트 수신처, 임시 리소스와 지출 상한 안에서만
허용한다.

### 2-4. 직접 기능 손실과 부수적 회귀를 분리한다

- **직접 기능 손실**: 비활성화한 툴 자체의 기능을 미래 사용자가 요청해 실패한다. 예상 가능한
  손실이며 기능 고지와 regret 복구로 평가한다.
- **부수적 회귀**: 사용자가 비활성화한 툴의 직접 기능을 요청하지 않았지만 다른 툴이나 워크플로가
  그 툴에 의존해 실패한다. 독립성 판정의 안전 실패다.

두 실패를 합산하면 독립성 판정과 사용 빈도 예측을 구분할 수 없으므로 모든 표에서 분리한다.

### 2-5. 실측·추정·불투명을 분리한다

MCP Lens의 `AccountingMode`(`UPFRONT`, `DEFERRED_MEASURABLE`, `DEFERRED_ESTIMATED`,
`DEFERRED_OPAQUE`)별로 결과를 분리한다. 정의 토큰, 실제 입력 토큰, 캐시 토큰, 검색으로 로드된
토큰과 응답 토큰을 서로 대체하지 않는다.

## 3. 연구 질문과 가설

| ID | 연구 질문 | 사전 가설 |
|---|---|---|
| RQ1 | MCP Lens의 정의 비용·호출·로드 회계가 원본 관측과 일치하는가? | 호출·로드 F1 99% 이상, measurable mode의 정의 비용과 실제 증분 입력 Spearman ρ 0.8 이상 |
| RQ2 | `Safe to disable`이 실제 입력·검색 비용을 줄이는가? | 사용자 프로필 중앙값 실제 비용 15% 이상 감소 |
| RQ3 | 성공률을 보존하는가? | All-on 대비 성공률 차이의 95% CI 하한이 -2%p 이상 |
| RQ4 | 의존성 분석이 usage-only보다 안전한가? | 부수적 회귀를 usage-only 대비 80% 이상 감소 |
| RQ5 | 비활성화한 툴이 다시 필요할 때 감지·복구하는가? | regret recall 85% 이상, 복구 후 성공률 90% 이상 |
| RQ6 | 분석 비용이 절감으로 회수되는가? | 일반 사용자 프로필 중앙값 50세션 이내 손익분기 |
| RQ7 | 효과가 클라이언트·모델·도구 로딩 방식에 따라 달라지는가? | 결과를 통합값과 네 실행 조합별로 모두 공개 |

사전 가설은 성공 선언을 결과에 맞춰 바꾸지 않는다. 임계값 미달도 그대로 공개한다.

## 4. 벤치마크 구성

### 4-1. 3개 트랙

| 트랙 | 규모 | 목적 |
|---|---:|---|
| Server Track | 30서버 × 6과제 = 180개 | 서버 내부 회계·읽기·쓰기·방향성 의존·희귀 기능 평가 |
| Workflow Track | 30개 과제 | 2~4개 서버를 결합한 실제 사용자 워크플로 평가 |
| Longitudinal Track | 14일 관찰 + 7일 미래 구간 | 미사용 판정, 비활성화, 직접 손실, 부수적 회귀, regret 복구 평가 |

고유 미래 평가 과제는 210개다. 관찰 구간 실행은 별도이며 10,080회 본 실행 수에 포함하지 않는다.

### 4-2. 실행 조합

Claude Code와 Codex에서 각각 두 모델을 쓴다.

- **flagship**: 벤치마크 동결일에 해당 클라이언트에서 일반 제공되는 최고 성능 모델
- **economy**: 같은 MCP·비대화형 실행 기능을 지원하는 모델 중 입력 단가가 가장 낮은 모델

이동 alias는 금지한다. `models.lock.json`에 제공자, 정확한 model ID, 모델 공개일, 가격표 URL,
입·출력·캐시 단가, 클라이언트 버전, 선택일을 고정한다. 동결 후 모델이 단종되면 조용히 대체하지
않고 해당 실행을 `unavailable`로 공개한다.

### 4-3. 비교 조건

같은 관찰 DB 스냅샷을 네 개의 격리된 실행 홈에 복제한 뒤 아래 조건을 비교한다.

| 조건 | 정책 |
|---|---|
| `all-on` | 모든 도구 활성화. 제품 효과 기준선 |
| `usage-only` | eligibility를 통과하고 관찰 구간 호출이 0인 툴을 의존성 판정 없이 비활성화 |
| `mcplens` | MCP Lens가 `Independent`이면서 모든 eligibility를 통과한 툴만 비활성화 |
| `oracle` | gold inbound dependency graph와 관찰 자료를 사용해 안전한 툴만 비활성화하는 상한선 |

각 미래 과제를 네 실행 조합 × 네 조건 × 3회 반복한다.

```text
210 tasks × 4 client/model combinations × 4 policies × 3 repeats = 10,080 runs
```

모든 실행은 별도 `HOME`, MCP 설정, Lens DB, inbox, 로그 디렉터리를 사용한다. 실제 사용자의
`~/.mcplens/lens.db`와 클라이언트 설정을 읽거나 수정하지 않는다.

## 5. HTTPS MCP 30개 선정

### 5-1. 표현의 한계

공개 레지스트리에 일관된 실제 사용자 수가 없으므로 “가장 많이 사용되는 30개”라고 주장하지
않는다. 공식 Registry와 공개 디렉터리에서 반복적으로 발견되고 실제 실행 가능한 서버를
**commonly discoverable live remote MCP servers**라고 표현한다.

### 5-2. 후보 스냅샷과 공개 점수

동결일에 아래 네 소스의 원본 응답과 수집 시각을 저장한다.

1. Official MCP Registry
2. PulseMCP
3. Glama
4. Smithery

후보별 공개 점수는 다음 식으로 계산한다.

```text
publicScore =
  0.35 × directoryPresence
  + 0.25 × repositoryInterest
  + 0.20 × maintenanceActivity
  + 0.20 × officialProvider
```

- `directoryPresence`: 네 소스 중 등장 비율
- `repositoryInterest`: 연결된 공개 저장소의 `log10(stars + 1)` 백분위. 공개 저장소가 없으면 0
- `maintenanceActivity`: 마지막 릴리스/커밋이 90일 이내면 1, 365일 이내면 0.5, 그 외 0
- `officialProvider`: 서비스 운영자가 직접 제공하거나 공식 문서에서 연결하면 1, 아니면 0

점수는 실제 사용량이 아니라 재현 가능한 공개 관심·발견 가능성 지표다. 원자료, 정규화 전 값,
최종 점수와 탈락 사유를 `selection.csv`로 공개한다.

### 5-3. 필수 eligibility

서버는 아래를 모두 만족해야 한다.

- 공개 HTTPS Streamable HTTP endpoint가 있다.
- `initialize`와 `tools/list`가 14일 사전 점검 중 12일 이상 성공한다.
- `tools/list` p95가 5초 이하다.
- 도구가 3개 이상이다.
- 최소 하나의 읽기 도구와 하나의 **되돌릴 수 있는** 쓰기 도구가 있다.
- 전용 테스트 계정 또는 sandbox에서 초기 상태 구성·결과 검증·cleanup이 가능하다.
- 자동화된 테스트가 서비스 약관과 rate limit을 위반하지 않는다.
- 필요한 OAuth/API key를 최소 권한으로 발급할 수 있다.

상위 후보가 탈락하면 같은 도메인의 다음 점수 후보를 선택한다. 선정 후에는 결과가 불리하다는
이유로 서버를 교체하지 않는다.

### 5-4. 층화

다음 여섯 도메인에서 각각 5개를 선정하고 한 운영자의 서버는 최대 2개로 제한한다.

1. Source control·developer tooling
2. Deployment·observability
3. Documents·files·content
4. Productivity·project management
5. Communication·calendar
6. Data·analytics·commerce operations

최종 30개에는 OAuth 서버가 최소 15개, API key 서버가 최소 5개 포함되어야 한다. 나머지는
인증 방식 제한이 없다. 이 조건을 만족하지 못하면 전체 벤치마크를 시작하지 않는다.

## 6. 과제 설계

### 6-1. Server Track의 서버당 6개 과제

| ID | 과제 | 필수 성질 |
|---|---|---|
| `R1` | 단일 읽기 | 외부 상태를 바꾸지 않고 정답을 독립 검증 |
| `W1` | 단일 쓰기 | run 전용 리소스를 만들고 검증 후 삭제 |
| `D1` | 명시적/스키마 흐름 의존 | 앞 툴 출력이 뒤 툴 입력에 필요 |
| `D2` | ambient state 의존 | 현재 문서·페이지·선택 항목 같은 상태를 선행 툴이 구성 |
| `S1` | 검색 오염 | 관련 툴을 검색·로드할 가능성이 있지만 정답에는 호출이 불필요 |
| `H1` | 희귀/holdout | 관찰 구간에는 실행하지 않고 미래 구간에서 비활성 툴 필요성을 유발 |

자연어 프롬프트에는 MCP 서버명과 툴명을 쓰지 않는다. 각 과제는 `setup → execute → assert → cleanup`
계약을 가지며, setup과 assert는 가능하면 제공자의 독립 REST API 또는 관리자 조회면을 사용한다.
에이전트의 최종 문장이나 해당 MCP 툴의 자기 보고만으로 성공을 판정하지 않는다.

쓰기 리소스명에는 `mcplens-bench-{runId}`를 넣는다. cleanup은 멱등이어야 하고, cleanup 실패는
즉시 해당 계정의 후속 쓰기 실행을 중단하는 kill switch를 건다.

### 6-2. Workflow Track 30개

다섯 사용자 프로필에서 각 6개를 만든다.

| 프로필 | 연결 서버 수 | 대표 흐름 |
|---|---:|---|
| Software developer | 8~10 | 저장소 → CI/배포 → 오류 추적 → 문서 |
| PM·operations | 6~8 | 프로젝트 항목 → 문서 → 메시지 → 일정 |
| Data·research | 6~8 | 검색 → 데이터 조회 → 파일/문서 기록 |
| Content·support | 6~8 | 입력 수집 → 콘텐츠 갱신 → 알림 |
| Power user | 12~15 | 세 도메인 이상을 잇는 장기 워크플로 |

각 과제는 2~4개 서버와 3~6개 툴 호출을 요구한다. 동일 서버만 쓰는 우회로가 있으면 gold graph에
대체 경로로 명시한다. 성공 판정은 최종 외부 상태와 필요한 사실 claim을 함께 검사한다.

별도로 30개 서버 전체를 연결한 스트레스 실행을 Server Track의 읽기 과제 30개에 대해 수행한다.
이 결과는 일반 사용자 절감률에 합산하지 않고 확장성 절에만 싣는다.

### 6-3. 14일 관찰 구간

클라이언트·모델 조합별로 서버당 12개 세션을 14일에 분산한다. `R1`, `W1`, `D1`, `D2`, `S1`을
고정 seed의 가중 스케줄로 실행하고 `H1`은 실행하지 않는다. 각 서버의 첫날과 마지막 날 세션을
포함해 MCP Lens의 7일 관찰 조건을 실제 시간으로 만족시킨다.

14일 종료 시 아래를 원자적 스냅샷으로 동결한다.

- Lens DB와 원본 클라이언트 로그
- 서버별 `tools/list`, definition set hash와 scan 상태
- recommendation·dependency analysis 결과
- 클라이언트·모델·가격 lock
- 비활성화 전 설정 파일과 endpoint identity hash

### 6-4. 7일 미래 구간

동결한 관찰 스냅샷을 네 조건에 복제하고 210개 과제를 실행한다. 실행 순서는
`server/task × client/model` 블록 안에서 정책과 반복 순서를 무작위화한다. 같은 블록은 2시간
안에 끝내 외부 서비스 상태 변화가 한 정책에만 치우치지 않게 한다.

`H1`은 다음을 구분하도록 설계한다.

- 비활성 툴의 직접 기능이 다시 필요함
- 비활성 툴이 다른 툴의 선행 단계로 필요함
- 대체 경로가 있어 비활성 툴 없이도 성공 가능함

regret 신호가 생기면 원래 실행은 실패 또는 우회 결과 그대로 기록한다. 그 다음 정해진 복구
절차로 툴을 복원하고 동일 run seed를 한 번 더 실행해 복구 후 성공률과 추가 비용을 측정한다.

## 7. Gold dependency graph

### 7-1. 방향과 라벨

프로젝트 계약과 동일하게 `B → A`는 **B가 A를 필요로 함**, 즉 A의 `dependedOnBy`에 B가 들어감을
뜻한다. 각 edge는 다음 하나로 라벨한다.

- `required`: A 없이 B 또는 해당 워크플로가 정해진 상태에서 성공할 수 없음
- `alternative`: A가 한 경로에는 필요하지만 동등한 허용 대체 경로가 있음
- `none`: 의존 없음
- `unknown`: 약관·비용·비가역성 때문에 실행 확인 불가

안전성의 positive edge는 `required`다. `alternative`는 대체 경로 성공률에서 별도 평가하고,
`unknown`은 Precision/Recall 분모에서 제외하되 개수와 이유를 공개한다.

### 7-2. edge 근거 유형

- 정의 텍스트의 선행 지시·형제 툴 참조
- input/output schema의 불투명 값 흐름
- ambient state producer/consumer
- 관찰된 호출 연쇄
- 의미적 워크플로 필요성
- 실제 tool ablation 결과

### 7-3. 라벨 절차

1. 두 명의 라벨러가 도구 정의, schema와 과제만 보고 독립 라벨링한다.
2. 불일치는 제3 라벨러가 adjudication한다.
3. Cohen's kappa와 라벨별 합의율을 공개한다.
4. `Safe to disable` 후보에 진입하는 모든 툴은 실제 비활성화 검증을 수행한다.
5. gold `required` edge가 안전 후보와 연결되면 해당 collateral task를 최소 한 개 실행한다.

모든 툴의 direct capability와 inbound dependency를 라벨하지만, 외부 쓰기 ablation은 위 4·5항에
해당하는 안전 결정 경계에 집중한다.

## 8. 독립 관측과 성공 판정

### 8-1. 호출 ground truth

MCP Lens가 읽기 전의 원본 Claude Code·Codex 로그를 보존하고 별도 benchmark parser가 세션,
tool search/load, tool call, 오류와 usage event를 추출한다. Lens DB와 benchmark parser 결과를
`sessionId + client + server + tool + externalCallId`로 대조한다. parser 불일치는 원본 이벤트를
두 명이 확인해 adjudication한다.

### 8-2. 외부 상태 ground truth

- 읽기 과제: 독립 REST/API 응답 또는 동결 fixture hash와 비교
- 쓰기 과제: 에이전트 경로와 다른 관리자 API/조회 경로로 상태 변화 확인
- 메시지·이메일: benchmark 전용 수신함에서 run ID 확인
- 배포·결제: 제공자의 preview/test mode와 지출 상한 안에서 상태 확인
- 파일·문서: 내용 hash, 소유자와 run ID를 확인한 뒤 cleanup

최종 답변의 사실 정확성이 필요한 과제는 deterministic assertion을 먼저 쓰고, 표현이 다양한
claim만 고정 rubric으로 판정한다. LLM-as-a-judge 단독 판정은 금지한다.

### 8-3. 외부 장애 처리

- run 직전 `initialize`, `tools/list`와 최소 read health probe를 수행한다.
- probe가 모든 정책에서 실패하면 해당 블록을 최대 72시간 안에 같은 seed로 재시도한다.
- 72시간 뒤에도 실패하면 `environment-unavailable`로 공개하고 성공률 분모에서 제외한다.
- 특정 정책에서만 실패하거나 tool call 뒤 실패하면 제품 결과로 포함한다.
- 동결 후 불리한 결과를 이유로 서버·과제·모델을 교체하지 않는다.

## 9. 지표

### 9-1. 회계 정확성

| 지표 | 정의 |
|---|---|
| Call exact match | benchmark parser와 Lens DB의 서버·툴별 호출 수 완전 일치 비율 |
| Load precision/recall | 원본 search/load event 대비 `tool_loads` 탐지 |
| Search pollution accuracy | loaded ≥1, called =0 세션·툴 쌍의 판정 정확도 |
| Definition calibration error | 툴 단독 on/off paired run의 실제 증분 입력 대비 정의 비용 추정 절대 오차 |
| Scan coverage | 30개 서버 중 정의·schema·identity를 정상 스캔한 비율 |

Definition calibration은 accounting mode와 클라이언트별로 보고한다. 실제 증분 입력을 관측할 수
없는 `DEFERRED_OPAQUE`는 오차 계산에서 제외하고 제외 수를 공개한다.

### 9-2. 효율성

```text
InputTokenReduction = 1 - totalInputTokens(policy) / totalInputTokens(all-on)
SearchPollutionReduction = 1 - unusedLoadedTokens(policy) / unusedLoadedTokens(all-on)
CostReduction = 1 - actualCost(policy) / actualCost(all-on)
```

추가로 출력·캐시 read·캐시 creation 토큰, 전체 도구 호출 수, 잘못된 호출 수, 재시도 수,
wall-clock median과 p95를 공개한다. 단가가 바뀌어도 재계산할 수 있도록 토큰 원시값과 당시 가격을
함께 배포한다. `actualCost`는 provider가 기록한 입력·출력·cache read·cache creation 토큰에
`models.lock.json`의 실행 당시 단가를 적용한 값이다. 정의 토큰 추정값으로 비용을 계산하지 않는다.

### 9-3. 안전성

```text
FalseSafeRate =
  gold inbound required dependency가 있는 Safe-to-disable 툴 수
  / 전체 Safe-to-disable 툴 수

CollateralRegressionRate =
  all-on에서는 성공했으나 빠진 선행 툴 때문에 실패한 비직접 과제 수
  / all-on 성공 비직접 과제 수
```

의존 edge Precision/Recall/F1, `Independent` precision, `Review required` abstention rate와
coverage도 공개한다. `Review required`를 오답으로 강제 변환하지 않는다. `Safe-to-disable` 판정이
0개면 `FalseSafeRate`를 0으로 쓰지 않고 `not-applicable`로 기록한다.

### 9-4. 제품 효과

- 전체 task success와 partial goal completion
- 일반·의존·희귀·대체 경로 과제별 success
- 직접 기능 손실률과 부수적 회귀율
- wrong-tool call, premature call, retry와 우회 호출 수
- regret precision/recall
- 복구 성공률, 복구까지 걸린 세션·시간·추가 토큰·비용

`wrong-tool call`은 gold의 어떤 허용 실행 경로에도 없고 외부 assertion 달성에도 기여하지 않은
호출이다. `premature call`은 gold precondition이 충족되기 전에 실행해 실패하거나 무효 상태를
만든 호출이다. 두 값은 tool name만으로 자동 판정하지 않고 실행 경로와 외부 상태를 함께 본다.

### 9-5. 손익분기

```text
BreakEvenSessions = oneTimeAnalysisCost / medianSavingsPerSuccessfulSession
```

`medianSavingsPerSuccessfulSession <= 0`이면 `infinite`로 기록한다. 실패를 싸게 만든 실행은 절감
분자에 넣지 않고 별도 실패 비용으로 공개한다. 서버·프로필·클라이언트·모델별 손익분기 분포를
제공한다. `oneTimeAnalysisCost`에는 dependency analysis의 실제 입력·출력·cache 비용과 원격
`tools/list` 제공자가 부과한 확인 가능한 비용을 포함한다. 로컬 스캔 CPU 시간은 비용과 별도로
wall-clock으로 공개한다.

## 10. 통계 계획

- binary success는 같은 task/seed의 paired 결과로 비교한다.
- 차이와 비율의 95% CI는 서버를 cluster 단위로 한 10,000회 bootstrap으로 계산한다.
- 모델·클라이언트별 네 하위 분석의 다중 비교 p-value에는 Holm 보정을 적용한다.
- 중앙값과 p95에는 task-level paired bootstrap CI를 붙인다.
- 평균값만 공개하지 않고 median, IQR, p95와 서버별 분포를 함께 공개한다.
- 최초 10%인 21개 과제를 pilot으로 실행해 하네스·assertion만 검증한다. pilot 결과를 보고 과제
  난이도나 임계값을 바꾸지 않으며, 하네스 결함을 고친 경우 pilot을 폐기하고 전 과제를 처음부터
  다시 실행한다.

## 11. 성공 기준

### 11-1. 최소 공개 가치

- 사용자 프로필 중앙값 실제 agent cost 15% 이상 감소
- All-on 대비 전체 성공률 차이 95% CI 하한이 -2%p 이상
- `FalseSafeRate ≤ 2%`
- `CollateralRegressionRate ≤ 1%`
- regret recall 85% 이상
- 일반 사용자 프로필 중앙값 손익분기 50세션 이하

### 11-2. 강한 제품 결과

- 실제 비용 25~40% 감소
- 성공률 유지 또는 개선
- `FalseSafeRate ≤ 1%`
- usage-only 대비 부수적 회귀 80% 이상 감소
- regret recall 90% 이상, 복구 후 성공률 95% 이상
- 일반 사용자 프로필 중앙값 손익분기 20세션 이하

### 11-3. 제품 방향 재검토 조건

- 실제 청구 기준 절감이 5% 미만
- 성공률 차이의 95% CI 하한이 -3%p 미만
- `FalseSafeRate > 5%`
- 중앙값 손익분기 100세션 초과
- deferred/search 기반 클라이언트에서 실측 절감이 사실상 없음

재검토 조건이 발생해도 서버·과제·실패를 삭제하지 않는다. 효과가 있는 accounting mode와 사용자
프로필로 제품 주장을 좁힌다.

## 12. 보안·윤리·비용 통제

- 모든 서비스에 벤치마크 전용 계정·조직·프로젝트를 사용한다.
- 최소 OAuth scope와 최소 권한 API key를 사용한다.
- `.env.example`에는 변수명만 공개하고 secrets, token, account ID는 커밋하지 않는다.
- 개인·운영 데이터, 실제 고객, 실제 결제수단, 공개 채널과 실제 배포 환경을 사용하지 않는다.
- 쓰기 도구마다 허용 리소스 prefix, 수신처 allowlist, 지출 상한, rate limit을 선언한다.
- 삭제는 현재 run ID가 소유한 리소스에만 허용한다.
- cleanup 실패, 지출 상한 접근, 예상 밖 외부 수신처 감지 중 하나가 발생하면 해당 서비스의 쓰기
  실행을 중지한다.
- 서비스별 약관·자동화 허용 근거와 확인 날짜를 `services.lock.json`에 기록한다.

## 13. 공개 저장소 산출물

벤치마크 구현은 아래 논리 구조를 따른다. 정확한 패키지 위치는 구현 계획에서 저장소 현황을 다시
확인해 정한다.

```text
benchmark/
  README.md
  methodology.md
  manifests/
    servers.lock.json
    models.lock.json
    services.lock.json
    selection.csv
  tasks/
    server/{serverId}/*.json
    workflow/{profile}/*.json
  gold/
    dependencies.jsonl
    capabilities.jsonl
  snapshots/
    registry/{freezeDate}/
    definitions/{freezeDate}/
  results/
    runs.jsonl
    summary.json
    tables/
    figures/
  schemas/
  scripts/
  .env.example
```

공개 run 레코드는 최소한 benchmark version, run ID, task ID, server/tool identity hash,
client/model/version, policy, repeat, seed, 시작·종료 시각, accounting mode, tool search/load/call,
토큰 4종, 당시 가격, 비용, latency, assertion 결과, failure class, cleanup 결과를 포함한다.
프롬프트·툴 입력·응답은 서비스 데이터가 섞일 수 있으므로 기본 비공개이며, 공개 가능한 합성
테스트 데이터만 별도 redacted artifact로 내보낸다.

## 14. 결과 표현

GitHub README 첫 화면에는 `30 Remote MCP Servers · 210 Real Tasks · 10,080 Future-Phase Runs`를
표제로 두고 아래 여섯 값을 실제 결과에서 생성한 카드로 표시한다.

1. actual input token reduction
2. actual agent cost reduction
3. All-on에서 MCP Lens로의 task success 변화
4. wrong tool call 감소율
5. collateral failure rate
6. median break-even sessions

필수 그림은 다음 다섯 개다.

1. 비용(x)과 성공률(y)의 `all-on`/`usage-only`/`mcplens`/`oracle` Pareto plot
2. 정의 토큰(x), loaded-but-uncalled 비율(y), 도구 수(bubble)의 서버별 낭비 지도
3. usage-only와 MCP Lens의 절감률·False Safe·부수적 실패 비교
4. 서버·사용자 프로필별 손익분기 세션 분포
5. disable → regret → restore → success 회수 funnel

Claude Code/Codex, flagship/economy, accounting mode와 사용자 프로필별 상세표를 함께 제공한다.
통합 결과만으로 특정 클라이언트의 퇴행을 숨기지 않는다.

## 15. 재현성 게이트

공개 릴리스는 아래를 모두 만족해야 한다.

- 서버·모델·가격·클라이언트·과제·gold graph가 versioned lock으로 동결됨
- 210개 과제의 setup/assert/cleanup이 pilot에서 모두 독립 검증됨
- 선택 후보와 탈락 사유가 공개됨
- 원시 run JSONL에서 모든 표·그림을 한 명령으로 재생성 가능함
- 동일 run seed의 중복·누락 검사가 통과함
- secrets와 외부 서비스 원문 데이터가 결과물에 없음을 검사함
- cleanup 잔여 리소스가 0임을 서비스별로 확인함
- 결과표의 분모, 제외 건수와 `environment-unavailable` 건수가 명시됨
- 실패한 가설과 재검토 조건도 성공 결과와 같은 위치에 공개됨

## 16. 비범위

- 모델 자체의 종합 tool-use leaderboard
- stdio MCP 서버
- Gemini CLI 비교
- 보안 취약점 스캐닝과 공격성 OAuth 검사
- 실제 사용자 개인정보·프롬프트 수집
- 정의 설명을 자동 축약하거나 MCP 서버 구현을 변경하는 최적화
- 30개 서버 순위를 실제 사용자 수 순위로 표현하는 것
- 성공률·비용·안전성을 임의 가중치로 합친 단일 점수

## 17. 선행 벤치마크와의 관계

- [MCP-Bench](https://arxiv.org/abs/2508.20453)의 실제 서버·다단계 실행 구조를 참고한다.
- [MCP-Atlas](https://arxiv.org/abs/2602.00933)의 claims 기반 부분 점수와 공개 harness 구조를
  참고하되 deterministic 외부 상태 assertion을 우선한다.
- [MCP-Universe](https://arxiv.org/abs/2508.14704)의 실제 서버와 실행 기반 evaluator를 참고한다.
- [TaskBench](https://proceedings.neurips.cc/paper_files/paper/2024/hash/085185ea97db31ae6dcac7497616fd3e-Abstract-Datasets_and_Benchmarks_Track.html)의
  방향성 tool graph를 gold dependency 표현에 참고한다.

기존 벤치마크의 작업 성공률을 그대로 재사용하는 것이 아니라, **관찰 → 분석 → 비활성화 → 미래
구간 → regret 복구**라는 MCP Lens 고유 개입을 추가하는 것이 이 벤치마크의 기여다.
