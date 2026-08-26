# MCP Lens 파일럿 평가

MCP Lens가 **하는 주장 하나하나가 참인지**를 재는 실험이다.
"Lens를 쓰면 좋아지나"를 한 덩어리로 묻지 않는다. 주장마다 실패 모드가 다르고,
앞의 주장이 틀리면 뒤의 주장은 재도 의미가 없기 때문이다.

`docs/superpowers/plans/2026-08-09-https-mcp-benchmark-corpus-freeze.md`의
30서버 코퍼스 동결(Gate 1)은 건너뛴다. 효과 크기와 주장 정확도를 모르는 상태에서
모집단부터 고정하는 것은 순서가 아니다.

## 평가 구조

| # | Lens의 주장 | 정답을 어떻게 만드나 | 평가 지표 | 층 |
|---|---|---|---|---|
| 1 | "이 도구 정의는 2,300토큰이다" | 동일 세션에서 해당 도구 활성/비활성 A/B 실행 | 실제 입력 토큰 차이, 추정 오차율 | 계측 |
| 2 | "검색으로 로드됐지만 호출되지 않았다" | Claude·Codex 원본 이벤트와 훅 기록 대조 | loaded-unused 판정 정확도 | 계측 |
| 3 | "30일 동안 0회 호출됐다" | 생성한 전체 호출 기록과 MCPLens DB 대조 | 호출 집계 정확도 | 계측 |
| 4 | "A는 독립적이다" | 사람이 검증한 도구 의존 그래프와 실제 ablation | 독립 판정 정확도, 위험한 오판율 | 추천 |
| 5 | "A는 꺼도 안전하다" | 실제로 A를 끄고 미래 과제를 다시 실행 | 비용 감소, 성공률 변화, 부수적 실패 | 추천 |
| 6 | "다시 필요해졌다" | 비활성화된 도구가 필요한 과제 실행 | regret 감지율, 복구 성공률 | 추천 |

**1~3은 계측층, 4~6은 추천층이다.** 계측이 틀리면 추천은 자동으로 틀린다.
그러므로 1~3을 먼저 통과시키고 4~6으로 넘어간다. 1~3은 태스크가 적게 들어 싸고,
4~6은 100개 태스크를 다 써서 비싸다. 비용이 뒤에 몰려 있고 앞에서 걸러진다.

각 주장의 코드 위치는 다음과 같다.

| # | 코드 |
|---|---|
| 1 | `packages/core/src/tokenize.ts` (`countTokens`, o200k_base) |
| 2 | `types.ts`, `adapters/codex/adapter.ts`, `store/store.ts`의 `toolSearch` |
| 3 | `store/`, `ingest/` |
| 4 | `dependency/analyzer.ts`, `dependency/eligibility.ts` |
| 5 | `dependency/eligibility.ts`, `dependency/rollout.ts`, `actions/` |
| 6 | `regret/claudeAttempt.ts` |

## 착수 전 검증 결과

2026-08-09에 스모크 런 3회와 Lens DB 사본 조회로 확인했다. 여섯 행 모두 측정 가능하다.

| 확인 항목 | 결과 |
|---|---|
| Lens가 헤드리스 런을 수집하나 | 수집한다. 훅이 아니라 로그 감시 경로다 |
| 모드 판별 | 2/2 정확. `DEFERRED_MEASURABLE` / `UPFRONT` |
| `tool_loads` 기록 | 원본 로그의 `tool_reference`와 1/1 일치 |
| `tool_calls` 기록 | 두 모드 모두 정확 |
| 6번 복구 경로 | `enableServer()`, `allowMcpTool()` 존재. 자동/수동 여부만 미확인 |

수집 경로는 다음과 같다. `claude -p` 런도 `~/.claude/projects/<경로>/`에 jsonl을 남기고,
Lens의 `watch/watcher.ts`가 그것을 읽는다. 실험용 훅을 따로 붙일 필요가 없다.

2번 행의 구현 위치도 확인했다. 앞서 `toolSearch` 문자열로만 검색해 놓쳤을 뿐,
Claude 어댑터는 `tool_result` 안의 `{type:'tool_reference'}`를 파싱해 `toolLoads`에 넣는다.
판정은 core의 `engine.ts:127 pickLoadPattern()`이 한다.

```ts
if (row.loadedSessionCount === 0) return null;
if (row.callCount === 0) return 'search-pollution';
```

extension의 `searchedNotCalled`는 이 값을 표시용으로 바꾼 이름이다. 계산은 core에 있다.

정의가 세션 단위가 아니라 **누적 단위**라는 점에 주의한다. 다른 세션에서 한 번이라도
호출됐으면 `search-pollution`이 아니다. 정답도 같은 기준으로 만든다.

### 2번 행에 필요한 추가 태스크

스모크에서 모델이 `ToolSearch`를 `select:mcp__deepwiki__ask_question` 형태로 호출했다.
툴 이름 목록이 시스템 리마인더에 이미 있어 키워드 검색이 필요 없었기 때문이다.
그 결과 로드 1개, 호출 1개, 오염 0이 됐다.

즉 **어느 툴을 쓸지 명확한 질문에서는 `search-pollution`이 구조적으로 발생하지 않는다.**
지금 100개는 대부분 그런 질문이다. 2번 행을 재려면 어느 툴인지 모호해서 모델이
키워드 검색을 하게 만드는 질문이 따로 필요하다. 예를 들면 "Next.js 관련 문서 찾아줘"처럼
Context7과 DeepWiki 중 어느 쪽인지 판단이 필요한 질문이다.

`tasks.jsonl`에 `type: "ambiguous"` 10개를 추가해 이 행 전용으로 쓴다.

## 대상 서버

무인증으로 접속되는 공개 원격 MCP 서버 5종이다. 2026-08-09에 `initialize`와
`tools/list`로 응답을 확인했다.

| 서버 | endpoint | 툴 | 정의 토큰(근사) |
|---|---|---|---|
| Hugging Face | `https://huggingface.co/mcp` | 4 | ~4,023 |
| AWS Knowledge | `https://knowledge-mcp.global.api.aws` | 5 | ~1,900 |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | 3 | ~1,215 |
| Context7 | `https://mcp.context7.com/mcp` | 2 | ~1,215 |
| DeepWiki | `https://mcp.deepwiki.com/mcp` | 3 | ~379 |
| 합계 | | 17 | ~8,732 |

근사값은 `JSON.stringify(tools).length / 4`로 잰 것이고, 1번 행에서 실측으로 교체된다.
무게가 10배 차이 난다는 점이 중요하다. Lens가 무거운 쪽을 먼저 끄라고 하는지 볼 수 있다.

제외한 서버와 이유는 다음과 같다. Terraform과 Semgrep은 `initialize`에 401이라 무인증이
아니다. GitMCP는 DeepWiki·Context7과 기능이 겹쳐 골드 라벨이 흐려진다.
Cloudflare Docs는 448토큰이라 꺼도 절감이 없다. Svelte는 6,156토큰으로 가장 무겁지만
프레임워크 하나짜리라 태스크 20개를 뽑기 어렵다.

### 이 조합에 이미 있는 의존 관계

4번 행의 정답 그래프에 쓴다. 사람이 확인한 것이다.

- **Context7 내부**: `resolve-library-id` → `query-docs`. 라이브러리 ID를 먼저 풀지 않으면
  문서를 못 가져온다. Lens가 `resolve-library-id`를 "독립적이라 꺼도 된다"고 하면
  그것이 곧 위험한 오판이다.
- **서버 간**: `chain` 태스크 15개가 서버 두 개를 동시에 요구한다. 한쪽을 끄면
  답이 절반만 나온다.

## 실측으로 확인된 하네스 동작

파일럿 착수 전 스모크에서 나온 것이며, 1번 행의 설계를 바꾼다.

**Claude Code는 MCP 툴을 기본적으로 지연 로딩(deferred)한다.** 툴 정의가 처음부터
컨텍스트에 들어가지 않고 모델이 `ToolSearch`로 그때그때 스키마를 끌어온다.

```
ToolSearch 허용:  cache_creation_input_tokens = 15,007   (모델이 ToolSearch 먼저 호출)
ToolSearch 차단:  cache_creation_input_tokens = 24,887   (툴 17개 즉시 로드)
차이                                            +9,880
```

차이 9,880이 툴 17개 정의를 미리 실은 실제 무게이고, `tools/list` 추산 8,732와 가깝다.

이것이 Lens의 전제에 직접 걸린다. 지연 로딩 상태에서는 툴 정의가 컨텍스트를 먹지 않으므로
"이 도구 정의는 2,300토큰이다"라는 주장의 실제 값이 0에 가까워진다.
따라서 1번 행은 **두 모드 각각에서** 재고, 모드별 오차율을 따로 보고한다.

| 모드 | 뜻 |
|---|---|
| eager | `ToolSearch` 차단. 툴 17개 즉시 로드. Lens가 가정하는 세계 |
| deferred | 하네스 기본값. Lens의 토큰 주장이 과대평가인지 확인 |

deferred 모드에서 절감 여지가 거의 없다는 결과가 나오면, 그것 자체가 제품 방향에
직결되는 답이다. "하네스가 이미 해결한 문제를 Lens가 다시 풀고 있는가"에 대한 답이기 때문이다.

## 태스크 세트

`tasks.jsonl`에 100개가 있다. 서버당 20개다.

```json
{
  "taskId": "HF-13",
  "type": "rare",
  "prompt": "내가 지금 허깅페이스에 로그인 돼 있어?",
  "goldServers": ["huggingface"],
  "goldTools": ["hf_whoami"],
  "assert": "hf_whoami 호출",
  "lensRisk": "hf_whoami는 사용 빈도가 낮아 Lens가 끄라고 추천할 확률이 높다"
}
```

| 필드 | 뜻 |
|---|---|
| `taskId` | `{서버접두사}-{번호}`. HF, AWS, MS, C7, DW |
| `type` | `single` / `rare` / `chain` / `distractor` |
| `prompt` | 클라이언트에 그대로 던질 문장 |
| `goldServers` | 호출되어야 하는 서버. `distractor`는 빈 배열 |
| `goldTools` | 호출되어야 하는 툴 이름 |
| `assert` | 사람이 답 내용을 볼 때의 판정 기준 |
| `lensRisk` | 이 태스크가 regret 후보인 이유 |

| 타입 | 수 | 어느 행에 쓰나 |
|---|---|---|
| `single` | 60 | 5번의 성공률 기준선 |
| `rare` | 15 | **6번의 핵심.** Lens가 빈도로 판단하면 끌 만한 툴을 굳이 필요하게 만든 태스크 |
| `chain` | 15 | 4번의 의존 오판 검출, 5번의 부수적 실패 |
| `distractor` | 10 | 5번의 과잉 호출 확인 |
| `ambiguous` | 10 | **2번 전용.** 키워드 검색을 유도해 search-pollution을 발생시킨다 |
| 합계 | 110 | |

`ambiguous`는 필드 구성이 다르다. 정답이 "어느 툴을 불렀나"가 아니라
"로드했는데 안 부른 툴이 무엇인가"이므로 `goldTools`가 비어 있고,
대신 `plausibleServers`와 `expectKeywordSearch`가 들어간다.

모호함은 세 축으로 만들었다. 서버 간 경계(AMB-01, 02, 04, 07),
서버 내 툴 경계(AMB-05), 대상 자체가 미지정(AMB-10)이다.

이 태스크들이 키워드 검색을 유도하지 못하고 모델이 그래도 `select:`를 쓰면,
그 사실 자체를 결과로 적는다. 실패가 아니라 "이 하네스에서는 오염이 잘 생기지 않는다"는
관측이기 때문이다.

절감만 재는 실험은 "다 꺼라"가 항상 이긴다. `rare` 15개가 껐을 때의 손해를
같은 단위로 재기 때문에 판정이 성립한다.

## 실행 환경

스모크로 확정한 구성이다. 오염원을 하나씩 제거한 결과다.

```bash
claude -p "<프롬프트>" \
  --mcp-config pilot/mcp-A.json --strict-mcp-config \
  --allowedTools mcp__huggingface mcp__awsknowledge mcp__mslearn mcp__context7 mcp__deepwiki \
  --disallowedTools <builtin 35종 + ToolSearch> \
  --model sonnet --output-format stream-json --verbose
```

| 설정 | 이유 |
|---|---|
| `--strict-mcp-config` | 사용자 기존 MCP 서버가 딸려 들어와 툴 개수를 오염시키는 것을 막는다 |
| `--disallowedTools`에 builtin 35종 | 막지 않으면 Cron·Workflow·Skill 등 25개가 로드돼 토큰이 오염된다 |
| `--disallowedTools`에 `ToolSearch` | eager 모드를 만든다. deferred 모드에서는 이것만 뺀다 |
| `--model sonnet` 고정 | 모델을 섞으면 교란 변수가 된다 |
| `stream-json` | 툴 호출 목록을 뽑아야 기계 채점이 된다 |
| 태스크마다 새 세션 | 앞 대화가 남으면 툴 선택에 영향을 준다 |

검증된 결과는 서버 5개 `connected`, 툴 정확히 17개, 비-MCP 툴 0개다.

### 남아 있는 오염: 사용자 훅

사용자 `settings.json`의 SessionStart·PreToolUse·PostToolUse·Stop 훅이 실험 세션마다
발동한다. `--settings '{"hooks":{}}'`는 병합이라 무력화되지 않고, HOME을 격리하면
인증이 끊긴다(`Not logged in`). `--bare`는 `ANTHROPIC_API_KEY`를 요구하는데 이 환경은
OAuth를 쓴다.

**그대로 두고 진행한다.** 오염이 모든 팔에 동일하게 들어가므로 팔 간 차이에서는
상쇄된다. 절대 토큰값만 부풀고 A/B 비교는 유효하다. 채점의 주축이 기계 판정
(골드 툴 호출 여부)이라서 답변 문체 변화의 영향도 받지 않는다.

다만 1번 행은 **절대값의 오차율**을 재므로 이 상수 오염을 반드시 빼고 계산한다.
빼는 방법은 툴 0개 구성으로 한 번 돌려 기준선을 잡고 그 값을 모든 측정에서 차감하는 것이다.

## 행별 실행 방법

### 1. 토큰 추정 정확도

툴 0개, 툴 17개, 그리고 서버 하나씩 뺀 5가지를 같은 프롬프트로 돌린다. 총 7구성이다.
서버 하나를 뺐을 때의 `cache_creation_input_tokens` 감소가 그 서버의 실제 무게다.

캐시가 교란 변수다. 같은 프롬프트를 반복하면 두 번째부터 `cache_read`로 빠지므로
구성마다 콜드 캐시에서 한 번만 잰다. 프롬프트는 툴을 안 부르는 `distractor` 중
하나로 고정한다. 툴 호출이 섞이면 입력 토큰이 호출 결과로 오염되기 때문이다.

지표는 서버별 `|Lens 추정 - 실측| / 실측`이다. eager와 deferred 두 모드에서 각각 낸다.

### 2. loaded-unused 판정 정확도

정답은 `stream-json`에서 직접 나온다. `ToolSearch` 호출로 로드된 툴 목록과
실제 `tool_use` 목록의 차집합이 loaded-unused다. 이것을 Lens의 판정과 대조한다.

착수 전 확인 항목에 걸려 있다. Claude 어댑터에 `toolSearch` 처리가 없으면 이 행은
Codex로 옮긴다.

### 3. 호출 집계 정확도

30일을 기다리지 않는다. 파일럿에서 실행한 전체 런의 `stream-json`이 곧 완전한 호출
기록이므로, 그것과 Lens DB의 집계를 대조한다.

지표는 툴별 호출 수의 정확 일치율, 누락 건수, 없는 호출을 만들어낸 건수다.
누락과 유령 호출은 방향이 다른 오류이므로 합치지 않고 따로 센다.

### 4. 독립 판정 정확도

Lens가 "독립적"이라고 한 툴마다 그것 하나만 끄고, 그 툴이 필요한 태스크와
**그 툴에 의존하는 다른 툴이 필요한 태스크**를 함께 돌린다.

사람이 검증한 정답 그래프는 위 "이 조합에 이미 있는 의존 관계" 절이다.

지표 둘을 따로 낸다. 독립 판정 정확도는 전체 정오답률이고, **위험한 오판율**은
"독립적이라 했는데 껐더니 다른 것이 깨진" 비율이다. 후자가 훨씬 중요하다.
반대 방향 오판(의존적이라 해서 안 껐는데 사실 독립)은 절감을 놓칠 뿐 아무것도 부수지 않는다.

### 5. 꺼도 안전한지

Lens 추천대로 끈 구성으로 100개를 다시 돌린다.

**B팔 구성은 Lens의 실제 추천으로만 정한다.** 사람이 임의로 고르면
"Lens가 맞았나"가 아니라 "내가 잘 골랐나"를 재게 된다.
따라서 실행 순서는 A팔 100개 → Lens 추천 확인 → B팔 100개다.

지표는 비용 감소율, 타입별 성공률 변화, 부수적 실패다.
부수적 실패는 "끈 툴과 무관한 태스크가 깨진 것"이며 따로 센다.

### 6. regret 감지와 복구

`rare` 15개와 `chain` 15개가 이 행을 위해 만들어졌다. B팔에서 이것들을 돌리면
껐던 툴이 필요해지는 상황이 실제로 발생한다.

지표는 regret 감지율(Lens가 "다시 필요해졌다"를 실제로 띄웠나)과 복구 성공률이다.
자동 복구 경로가 없으면 감지율만 낸다.

## 채점

두 단계다.

- **기계 판정**: `goldTools`를 호출했는가. `stream-json`에서 자동으로 뽑는다.
  `distractor`는 호출 0건이면 통과다.
- **사람 판정**: `assert`대로 답 내용이 맞는가. 기계 판정을 통과한 것만 본다.

`rare`와 `chain`의 실패는 그냥 실패로 적지 않고 원인을 남긴다.
툴이 꺼져서 실패한 것과 켜져 있었는데 안 고른 것은 다른 결론으로 이어진다.
전자는 Lens의 추천 오류이고 후자는 모델의 라우팅 문제다.

## 알고 시작하는 한계

- 서버 5개가 전부 읽기 전용 문서 검색이다. 쓰기·상태 변경이 걸린 위험은 재지 못한다.
  그것은 원 계획 Gate 2의 영역이다.
- 도메인이 개발자 문서 계열로 쏠려 있다.
- 프롬프트는 한국어인데 서버 문서는 영어다. 라우팅 실패가 생기면 Lens 때문인지
  언어 때문인지 원문 트랜스크립트로 구분한다.

## 비용

sonnet 기준 실측 회당 $0.11~0.17이다.

| 층 | 런 수 | 대략 |
|---|---|---|
| 계측 (1~3) | ~30 | $5 |
| 추천 (4~6) | ~200 | $35 |

계측층이 통과하지 못하면 추천층은 실행하지 않는다.
