# MCP 서버 일일 배치 before/after 측정 설계

작성일: 2026-08-26. 기점 커밋: `ac34ed4`.

MCP Lens를 써서 **토큰이 얼마나 줄었는가**를 수치로 보이는 실험이다. 하루에 서버 10개씩
측정하고 장부에 쌓아, 최종적으로 서버 50~100개에 대한 누적 표 한 장을 만든다.

`pilot/README.md`의 파일럿 평가(주장 6개의 참·거짓)와 목적이 다르다. 파일럿은 "Lens 주장이
정확한가"를 재고, 이 실험은 "Lens대로 했더니 얼마가 남았는가"를 잰다. 러너·채점기·격리
Lens 홈은 파일럿 것을 그대로 쓴다.

## 1. 목표·비범위·완료 조건

### 목표

- 서버 배치(10개)마다 다음 문장을 실측값으로 채운다.
  > 서버 10개 중 Lens가 K개 서버와 M개 툴을 끄라 함. 태스크당 입력 토큰 B → A (−P%).
  > 성공률 S_before → S_after, regret R건. Lens 추정 오차 E%.
- 배치 결과를 `pilot/ledger/day-NN.json`에 남기고, 누적 스크립트가 전 배치 합계를 출력한다.
- **각 서버에 어떤 프롬프트를 던졌는지**를 원문 그대로 기록한다. 프롬프트 없는 수치는
  재현이 안 되므로 결과로 인정하지 않는다.

### 비범위

- 서버 100개를 한 번에 올리지 않는다. 컨텍스트 창을 넘고, 하루 단위가 목적에 맞는다.
- Lens 추천 로직 자체를 고치지 않는다. 틀린 추천은 그대로 장부에 적는다.
- 파일럿의 2번 행(search-pollution)과 4번 행(의존 판정)은 이 실험에서 재지 않는다.
- OAuth가 필요한 서버는 1일차에 넣지 않는다. 확보되는 순서대로 뒤 배치에 넣는다.

### 완료 조건 (배치 1회 기준)

- `pilot/ledger/day-NN.json`이 아래 7절 스키마로 존재하고 `node pilot/ledger.mjs --check day-NN`이
  통과한다.
- 서버 10개 전부 `measuredTokens`, `lensEstimateTokens`, `verdict`, `taskIds`가 채워져 있다.
- before·after 두 팔 모두 20개 태스크의 트랜스크립트가 `pilot/.work/transcripts/` 아래에 있고,
  장부의 `taskIds`가 `pilot/tasks/day-NN.jsonl`의 레코드와 1:1로 대응한다.
- `node pilot/ledger.mjs --summary`가 누적 표를 출력한다.

## 2. 전제와 판단 근거

### Claude Code는 기본적으로 툴 정의를 지연 로딩한다

파일럿 스모크 실측이다.

```
ToolSearch 허용 (deferred):  cache_creation_input_tokens = 15,007
ToolSearch 차단 (eager):     cache_creation_input_tokens = 24,887
차이                                                       +9,880  (툴 17개)
```

deferred에서는 정의가 컨텍스트에 안 실리므로 before가 0에 가깝다. 따라서 **본 측정은
eager 모드**(`--disallowedTools ToolSearch`)로 한다. 이것은 Lens가 가정하는 세계이고, Codex·
Gemini CLI처럼 정의를 미리 싣는 클라이언트의 현실이다. 정직성을 위해 배치마다 deferred
1런을 추가로 돌려 그 값도 장부에 적는다. 숨기면 나중에 반박당한다.

### 하루 10개면 컨텍스트 상한과 재생 서버가 필요 없다

서버 100개를 eager로 올리면 정의만 200k를 넘어 세션이 시작조차 못 한다. 10개면 합계
2만 토큰 안팎이라 실서버로 직접 측정할 수 있다. 정의 원문을 재생하는 가짜 서버가 필요 없다.

### 공개 표기는 서버마다 따로 판단한다

측정값(툴 수, 정의 토큰 수, 호출 수)은 사실이라 저작권 대상이 아니다. 위험은 두 가지다.

- 약관의 벤치마크 결과 공개 금지 조항. 서버마다 약관을 읽고 날짜를 적는다.
- 툴 description·스키마 원문 재배포. 원문 스냅샷은 저장소에 커밋하지 않고 토큰 수만 남긴다.
  OSS(MIT/Apache) 서버는 라이선스를 표기하면 원문도 가능하다.

그래서 서버 레지스트리에 `license`, `tosChecked`, `benchmarkClause`, `publishName` 필드를 둔다.
`publishName=false`인 서버는 공개 표에서 `server-A`처럼 익명 처리하고 매핑은 비공개로 둔다.
측정은 공개 여부와 무관하게 진행한다. 이것은 법률 자문이 아니며, 대형 SaaS를 실명으로
공개하기 전에는 해당 약관 원문을 사람이 한 번 읽는다.

## 3. 측정 정의

`claude -p --output-format stream-json`이 남기는 `usage`를 쓴다. Lens DB에서 숫자를 가져오지
않는다. Lens는 검증 대상이므로 진실 기준이 될 수 없다.

### 층 1. 정의 무게 (정적, 서버당)

```
context(cfg) = 첫 assistant 메시지의 usage에서
               input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

캐시는 세 버킷 사이의 배분만 바꾸고 합은 바꾸지 않으므로 콜드·웜과 무관하게 안정적이다.
12구성(툴 0개, 10개 전부, 하나씩 뺀 10개)을 같은 distractor 프롬프트로 1런씩 돌린다.

```
measuredTokens(server_k) = context(all10) − context(minus_k)
harnessBaseline           = context(none)
errorRate(server_k)       = |lensEstimateTokens − measuredTokens| / measuredTokens
```

`lensEstimateTokens`는 격리 Lens 홈의 `mcp-lens scan` 결과(`tool_definitions.definition_tokens`
서버 합계)다.

### 층 2. 태스크당 비용 (동적, 팔당)

정의는 매 턴 다시 들어간다. 툴을 3번 부르면 4번 실린다. 첫 턴만 재면 효과를 그만큼
과소평가하므로 턴 합계로 잰다.

```
taskTokens(run) = Σ_assistant메시지 (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
before = mean(taskTokens, 팔 A, 20태스크)
after  = mean(taskTokens, 팔 B, 같은 20태스크)
savedPercent = (1 − after / before) × 100
```

`result.usage`가 세션 누적값이면 그것과 위 합이 같아야 한다. `ledger.mjs --check`가 두 값을
대조하고 1% 넘게 다르면 실패시킨다. 달러는 버킷별 단가를 적용해 따로 낸다
(`cache_read` 0.1배, `cache_creation` 1.25배, 나머지 1배). 토큰과 달러 둘 다 장부에 둔다.

### 층 3. 성공률과 regret

`pilot/grade.mjs`의 기계 판정(골드 툴 호출 여부)을 두 팔에 같이 적용한다.

```
success_before = 골드 툴 호출 성공 수 / 20
success_after  = 같은 기준
regret         = 팔 A에서 성공했고 팔 B에서 실패한 태스크
```

regret은 원인을 둘로 나눠 적는다. `disabled`(끈 툴이 필요했다)는 Lens 추천 오류이고,
`routing`(툴이 켜져 있었는데 안 골랐다)은 모델 문제다. 절감 수치에서 regret을 빼거나
숨기지 않는다. 절감 −40%에 성공률 −20%면 절감이 아니다.

### 팔 B는 Lens 출력으로만 정한다

팔 A 20런 뒤 격리 Lens 홈에서 `mcp-lens report --format json`을 뽑고, 각 툴의
`recommendation.action`을 다음 규칙으로 서버 verdict로 접는다.

| 서버의 툴 action 분포 | verdict | 팔 B 구성 |
|---|---|---|
| 모든 툴이 `remove` | `off` | 서버 제거 |
| 일부만 `remove` 또는 `filter-server` | `partial` | 서버 유지, 해당 툴만 `--disallowedTools mcp__<server>__<tool>` |
| `keep`·`unknown`·`inspect`만 | `keep` | 그대로 |

사람이 고르면 "Lens가 맞았나"가 아니라 "내가 잘 골랐나"를 재게 되므로 개입하지 않는다.

### 예시 (가상 숫자, 비율은 파일럿 실측 근사)

팔 A에서 태스크당 평균 78,000토큰. Lens가 memory·cloudflare-docs·sequential-thinking 서버
`off`, svelte `partial`(툴 4개 제외)을 내놓고 턴당 7,500 절감을 주장. 팔 B에서 55,000토큰.
성공 19/20 → 19/20, regret 0. 실측 절감 7,600, 오차 1%.

> 1일차: 서버 10개 중 Lens가 3서버 + 4툴을 끄라 함. 태스크당 78,000 → 55,000 (−29%).
> 성공률 19/20 → 19/20, regret 0건. 추정 오차 1%.

## 4. 일일 프로토콜

배치 = 서버 10개 = `day-NN`. 순서를 바꾸지 않는다. 팔 A가 끝나야 Lens 추천이 나오고,
추천이 나와야 팔 B 구성이 정해진다.

| 단계 | 내용 | 런 수 |
|---|---|---|
| 0 | `pilot/servers.json`에 서버 10개 등록(약관·라이선스 필드 포함). `pilot/tasks/day-NN.jsonl`에 서버당 태스크 2개 작성 | 0 |
| 1 | 무게 실측. 12구성 × distractor 1런, eager. 층 1 산출 | 12 |
| 2 | 팔 A. 10개 전부 켜고 20태스크, eager. Lens 격리 홈이 수집 | 20 |
| 3 | `mcp-lens scan` + `report --format json`. 서버별 verdict 기록. 사람 개입 없음 | 0 |
| 4 | 팔 B. verdict대로 구성해 같은 20태스크, eager | 20 |
| 5 | deferred 정직성 런. 10개 전부 켜고 `ToolSearch` 허용, distractor 1런 | 1 |
| 6 | `ledger.mjs --build day-NN` → `pilot/ledger/day-NN.json`. `--summary`로 누적 표 | 0 |

배치당 53런. sonnet 실측 회당 $0.11~0.17이므로 약 $6~9. 10배치 $60~90.

### 프롬프트 기록 규칙

- 프롬프트는 `pilot/tasks/day-NN.jsonl`에 **원문 그대로** 둔다. 러너는 이 파일의 `prompt`를
  글자 하나 바꾸지 않고 `claude -p`에 넘긴다.
- 런이 한 번이라도 돌아간 태스크의 `prompt`는 수정하지 않는다. 고쳐야 하면 새 `taskId`를
  만든다(예: `SV-01` → `SV-01b`). 옛 레코드는 지우지 않고 `retiredBy` 필드로 후속 ID를 가리킨다.
- 장부는 `taskId`만 참조하지 않고 실행 시점의 `prompt` 사본과 `promptSha256`을 함께 저장한다.
  나중에 태스크 파일이 바뀌어도 그날 실제로 던진 문장이 남는다.
- 층 1의 distractor 프롬프트도 같은 파일에 `type: "distractor"`로 두고 장부의
  `weightProbe.taskId`가 가리킨다.
- 트랜스크립트 경로(`pilot/.work/transcripts/<config>/<taskId>.jsonl`)를 장부에 적는다.
  `.work`는 gitignore 대상이므로 배치가 끝나면 `pilot/ledger/day-NN/transcripts/`로 복사해
  커밋한다. 트랜스크립트 안의 툴 응답에 서버 원문이 들어가므로 `publishName=false`인 서버의
  트랜스크립트는 복사하지 않고 `promptSha256`과 usage 수치만 남긴다.

## 5. 서버 배치 규칙과 1일차 배치

### 배치 규칙

- 무인증 원격 → API key 한 줄(env var 하나) → OAuth 순으로 앞 배치부터 채운다.
- 배치 안에 무게 양극단을 하나씩 넣는다(500토큰 이하 1개, 4,000토큰 이상 1개). Lens가 가벼운
  것을 "keep", 무거운 것을 "off"로 가르는지 보기 위해서다.
- 기능이 겹치는 서버 둘을 같은 배치에 넣지 않는다. 골드 툴 판정이 흐려진다.
- 다음 배치 10개는 전날 확정하고 `initialize`가 200인지 확인한다.

### 1일차 배치 (2026-08-26 `initialize` 200 확인)

| # | 서버 | 종류 | 툴 | 정의 토큰(근사) | license | tosChecked | publishName |
|---|---|---|---|---|---|---|---|
| 1 | huggingface | http `https://huggingface.co/mcp` | 4 | ~4,100 | 서비스 약관 | 미확인 | 보류 |
| 2 | awsknowledge | http `https://knowledge-mcp.global.api.aws` | 5 | ~1,900 | 서비스 약관 | 미확인 | 보류 |
| 3 | mslearn | http `https://learn.microsoft.com/api/mcp` | 3 | ~1,200 | 서비스 약관 | 미확인 | 보류 |
| 4 | context7 | http `https://mcp.context7.com/mcp` | 2 | ~1,200 | 서비스 약관 | 미확인 | 보류 |
| 5 | deepwiki | http `https://mcp.deepwiki.com/mcp` | 3 | ~320 | 서비스 약관 | 미확인 | 보류 |
| 6 | cloudflare-docs | http `https://docs.mcp.cloudflare.com/mcp` | 실측 | ~450 | 서비스 약관 | 미확인 | 보류 |
| 7 | svelte | http `https://mcp.svelte.dev/mcp` | 실측 | ~6,150 | 서비스 약관 | 미확인 | 보류 |
| 8 | memory | stdio `npx -y @modelcontextprotocol/server-memory` | 9 | ~2,000 | MIT | 불필요 | true |
| 9 | filesystem | stdio `npx -y @modelcontextprotocol/server-filesystem <runCwd>` | 실측 | 실측 | MIT | 불필요 | true |
| 10 | sequential-thinking | stdio `npx -y @modelcontextprotocol/server-sequential-thinking` | 1 | 실측 | MIT | 불필요 | true |

근사값은 `JSON.stringify(tools).length / 4`이고 층 1에서 실측으로 교체된다. 제외: gitmcp
(deepwiki·context7과 기능 중복), semgrep·github copilot(`initialize` 401).

1~5는 `pilot/tasks.jsonl`의 기존 태스크에서 `single` 1개와 `rare` 1개를 고른다.
6~10은 신규 작성한다. `filesystem`은 `runCwd`에 미리 만들어 둔 픽스처 파일을 읽는 태스크로
한다. 상대 경로 밖은 서버가 거부하므로 절대 경로를 프롬프트에 박지 않는다.

## 6. 통제 조건

| 설정 | 값 | 이유 |
|---|---|---|
| 로딩 모드 | eager (`--disallowedTools ToolSearch`) | 2절 |
| builtin 툴 | `runner.mjs`의 `BUILTINS` 35종 차단 | MCP 툴만 컨텍스트에 남긴다 |
| `--strict-mcp-config` | 항상 | 사용자 기존 서버 유입 방지 |
| 모델 | `sonnet` 고정 | 교란 변수 제거 |
| 세션 | 태스크마다 새 세션 | 앞 대화가 툴 선택에 영향 |
| 사용자 훅 | 그대로 둔다 | 모든 팔에 동일 상수. 툴 0개 구성이 기준선이라 차감된다 |
| Lens 홈 | `pilot/.work/lenshome` 격리 | 실 DB 오염 금지 |
| 가드 | `runner.mjs`의 toolCount·connected·nonMcpTools 검사 | 구성과 다른 런은 집계 제외 |

## 7. 공유 계약

세 파일의 스키마다. 러너·채점기·장부가 모두 이것에 의존하므로 전량 적는다.

### 7.1 `pilot/servers.json` 레코드

기존 파일은 `{ name: { type, url } }` 평면 구조다. 하위 호환을 위해 MCP 접속 필드는 그대로
두고 메타 필드를 `_meta` 아래에 넣는다. 러너는 `_meta`를 `mcp.json` 생성 시 제거한다.

```jsonc
{
  "svelte": {
    "type": "http",
    "url": "https://mcp.svelte.dev/mcp",
    "_meta": {
      "batch": "day-01",
      "license": "service-terms",        // SPDX 식별자("MIT") 또는 "service-terms"
      "tosUrl": "https://...",           // 약관 URL. 없으면 null
      "tosChecked": null,                // "YYYY-MM-DD" 또는 null(미확인)
      "benchmarkClause": "unclear",      // "none" | "present" | "unclear"
      "publishName": false               // true면 공개 표에 실명, false면 익명
    }
  },
  "memory": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "_meta": {
      "batch": "day-01",
      "license": "MIT",
      "tosUrl": null,
      "tosChecked": null,
      "benchmarkClause": "none",
      "publishName": true
    }
  }
}
```

`tosChecked=null`이면 `publishName`은 `true`여도 `ledger.mjs --summary`가 익명으로 출력한다.
약관을 안 읽고 실명 공개하는 경로를 막기 위해서다.

### 7.2 `pilot/tasks/day-NN.jsonl` 레코드

기존 `pilot/tasks.jsonl` 필드에 `server`와 `batch`를 더한다.

```jsonc
{
  "taskId": "SV-01",                    // {서버접두사}-{번호}. 배치 안에서 유일
  "batch": "day-01",
  "server": "svelte",                   // 이 태스크가 겨냥하는 서버 1개. distractor는 null
  "type": "single",                     // "single" | "rare" | "distractor"
  "prompt": "Svelte 5의 $state 룬이 뭔지 공식 문서 기준으로 설명해줘",  // 원문. 실행 후 수정 금지
  "goldServers": ["svelte"],
  "goldTools": ["svelte-docs-search"],  // 실제 tools/list 이름. 픽스처가 진실
  "assert": "svelte-docs-search 호출, $state 설명 포함",
  "lensRisk": "svelte 툴 중 이것만 쓰이므로 나머지가 partial 대상이 된다",
  "retiredBy": null                     // 후속 taskId. 수정 대신 은퇴시킬 때만
}
```

서버당 정확히 2개(`single` 1, `rare` 1)와 배치 공통 `distractor` 1개. 총 21레코드.
`goldTools`는 층 1 실측 후 실제 `tools/list` 이름으로 채운다. 계획서 추정 이름과 다르면
실측이 진실이다.

### 7.3 `pilot/ledger/day-NN.json`

```jsonc
{
  "batch": "day-01",
  "date": "2026-08-27",
  "baseCommit": "ac34ed4",
  "model": "sonnet",
  "mode": "eager",
  "harnessBaseline": 15100,              // context(none)
  "weightProbe": { "taskId": "D1-DIST", "prompt": "...", "promptSha256": "..." },
  "servers": [
    {
      "name": "svelte",
      "publishName": false,
      "toolCount": 5,
      "lensEstimateTokens": 6150,
      "measuredTokens": 6020,
      "errorRate": 0.0216,
      "callsInArmA": 2,
      "verdict": "partial",              // "off" | "partial" | "keep"
      "deniedTools": ["svelte-a", "svelte-b", "svelte-c", "svelte-d"],
      "lensClaimedSavingsPerTurn": 4900,
      "tasks": [
        { "taskId": "SV-01", "type": "single", "prompt": "...", "promptSha256": "...",
          "transcriptBefore": "ledger/day-01/transcripts/arm-a/SV-01.jsonl",
          "transcriptAfter":  "ledger/day-01/transcripts/arm-b/SV-01.jsonl",
          "successBefore": true, "successAfter": true,
          "tokensBefore": 76600, "tokensAfter": 54100 }
      ]
    }
  ],
  "arms": {
    "before": { "config": "day-01-all", "taskCount": 20, "meanTaskTokens": 78000,
                "meanFirstTurnContext": 24900, "meanCostUsd": 0.23, "success": 19 },
    "after":  { "config": "day-01-lens", "taskCount": 20, "meanTaskTokens": 55000,
                "meanFirstTurnContext": 17400, "meanCostUsd": 0.16, "success": 19 }
  },
  "savedPercent": 29.5,
  "lensClaimedSavingsPerTurn": 7500,
  "measuredSavingsPerTurn": 7600,
  "regrets": [
    { "taskId": "ST-02", "server": "sequential-thinking", "tool": "sequentialthinking",
      "cause": "disabled" }                // "disabled" | "routing"
  ],
  "deferredProbe": { "firstTurnContext": 15007, "savedPercentVsEagerBefore": 39.7 },
  "lensReport": "ledger/day-01/lens-report.json"
}
```

`--summary`는 모든 `day-*.json`을 읽어 다음 표를 낸다. 서버 수, 정의 토큰 합계, `off`·`partial`
수, `savedPercent` 태스크 가중 평균, 성공률 변화, regret 합계(원인별), 추정 오차 평균.
`publishName=false` 또는 `tosChecked=null`인 서버는 `server-A` 식으로 치환한다.

### 7.4 구성 파일 생성 규칙

`pilot/configs/day-NN/` 아래에 러너가 읽는 기존 형식으로 생성한다.

| 파일 | servers | allowToolSearch | 용도 |
|---|---|---|---|
| `none.json` | `[]` | false | 층 1 기준선 |
| `all.json` | 10개 | false | 층 1, 팔 A |
| `minus-<server>.json` × 10 | 9개 | false | 층 1 |
| `lens.json` | verdict 반영 | false | 팔 B. 3단계 뒤 생성 |
| `deferred.json` | 10개 | true | 5단계 |

`expectedToolCount`는 층 1의 `all` 런에서 `system.init.tools` 길이를 읽어 채운다. 손으로
세지 않는다. `lens.json`은 `deniedTools`를 러너에 넘겨야 하므로 러너에 `disallowedTools`
배열 필드를 추가한다(8절 T1).

## 8. 태스크 분할

파일 소유권이 겹치지 않는 T1~T3는 병렬 가능하지만 규모가 작아 터미널 1개에서 순차로 한다.
T4는 실서버·격리 DB를 쓰는 직렬 웨이브다.

| Task | 내용 | Files | 모델 | 검증 |
|---|---|---|---|---|
| T1 | 러너 확장: `pilot/tasks/<batch>.jsonl` 읽기(`--batch`), `_meta` 제거, config의 `disallowedTools` 지원, 트랜스크립트 usage 합계 산출 | `pilot/runner.mjs` | sonnet | `node pilot/runner.mjs --config day-01/none --batch day-01 --tasks type:distractor --dry-run` |
| T2 | 구성 생성기 + 1일차 서버 등록 + 태스크 21개 작성 | `pilot/gen-configs.mjs`, `pilot/servers.json`, `pilot/tasks/day-01.jsonl` | opus (실서버 `tools/list` 실측으로 `goldTools`를 채우는 판단) | 생성된 13파일 존재, 태스크 21개 스키마 검증 |
| T3 | 장부 빌더·검사·누적 | `pilot/ledger.mjs`, `pilot/test/ledger.test.mjs`, `pilot/fixtures/ledger/**` | sonnet | `node --test pilot/test/` |
| T4 | 1일차 실행 (4절 0~6단계) | `pilot/ledger/day-01.json`, `pilot/ledger/day-01/**` | opus (실기기 디버깅) | 1절 완료 조건 |

T3 테스트 케이스와 단언(전량):

- `builds ledger from fixture transcripts`: `fixtures/ledger/day-00/` 트랜스크립트 4개(팔 A 2,
  팔 B 2)와 Lens 리포트 JSON에서 `savedPercent`가 `(1 − 54100/76600)*100`과 소수 2자리까지
  같다.
- `fails when result.usage disagrees with per-message sum by more than 1%`: 조작한 트랜스크립트로
  `--check`가 비0 종료하고 stderr에 `usage mismatch`를 포함한다.
- `folds tool actions into server verdict`: 툴 5개 중 4개 `remove`면 `partial`, 5개 전부면 `off`,
  `keep`만이면 `keep`.
- `anonymizes when tosChecked is null even if publishName is true`: 요약 표에 서버명 대신
  `server-A`가 나온다.
- `regret cause is disabled only when the gold tool was denied in arm B`: 골드 툴이 `deniedTools`에
  있으면 `disabled`, 없으면 `routing`.
- `rejects prompt edits after a run`: 장부의 `promptSha256`과 현재 태스크 파일 해시가 다르면
  `--check`가 `prompt changed after run: SV-01`로 실패한다.

## 9. 실행 프롬프트 (터미널 1개)

사전 조건 (사람): 루트에서 `git log --oneline -1`이 `ac34ed4` 이후 이 설계 문서를 포함한
커밋인지, `git status`가 깨끗한지 확인한다. 이 문서가 untracked면 worktree에 딸려가지 않는다.

권장 실행 설정: 모델 opus(오케스트레이터), T1·T3 서브에이전트는 sonnet, T2·T4는 opus.
에이전트 종류 general-purpose.

```
[1단계: 작업 공간 만들기] 다른 무엇보다 먼저 이것부터 해라.
루트 /Users/doo._.hyun/Study/Project/MCPLens-V2 에서
  git log --oneline -1
을 실행해 기점 커밋 해시를 기록하고,
  git worktree add .claude/worktrees/mcplens-daily-batch -b pilot/daily-batch
를 실행한 뒤 EnterWorktree 도구에 path=/Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/worktrees/mcplens-daily-batch 를 넘겨 세션을 옮겨라.
진입 후 아래를 확인하고, 하나라도 어긋나면 중단하고 BLOCKED로 보고해라:
  - pwd 가 /Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/worktrees/mcplens-daily-batch 인지
  - git log --oneline -1 이 루트에서 기록한 기점 커밋과 같은지
  - docs/designs/2026-08-26-일일-배치-before-after-측정-설계.md 와 pilot/README.md 가 존재하는지
  - git status --short 가 비어 있는지
  - ln -s /Users/doo._.hyun/Study/Project/MCPLens-V2/node_modules node_modules 후
    npm run build -w @mcp-lens/core && npm run build -w @mcp-lens/cli 가 성공하는지
  - packages/cli/dist/main.js 가 존재하는지

[2단계: 실행]
설계 문서 docs/designs/2026-08-26-일일-배치-before-after-측정-설계.md 의 8절 T1→T2→T3→T4 순서로 진행해라.
너는 오케스트레이터다. 태스크마다 Task 도구로 서브에이전트를 스폰하고(T1·T3 model=sonnet, T2·T4 model=opus),
각 태스크의 Files 밖 파일 수정은 금지다. packages/ 아래는 읽기만 한다.
T2에서 goldTools 는 실제 tools/list 응답 이름으로 채우고, 설계 문서의 추정 이름과 다르면 실측을 따르고 보고서에 차이를 적어라.
T4는 4절 프로토콜 0~6단계를 순서대로 실행하되 3단계(팔 B 구성)는 mcp-lens report --format json 출력만으로 정하고 사람이 고르지 마라.
T4 실행 전 HOME=pilot/.work/lenshome 이 격리돼 있는지 확인하고 ~/.mcplens/lens.db 를 절대 건드리지 마라.
각 태스크가 끝나면 8절 검증 명령을 직접 다시 실행해 통과를 확인하고, 태스크 단위로 한국어 커밋을 만들어라.
보고서는 /Users/doo._.hyun/Study/Project/MCPLens-V2/.claude/worktrees/mcplens-daily-batch/pilot/ledger/day-01/REPORT.md 에 한국어로 남기고,
마지막 줄에 1절 목표 문장을 실측값으로 채워 적어라.
완료 형식: "DONE day-01: 서버 10, off K, partial M, saved P%, success S1→S2, regret R" 또는 "BLOCKED: <이유>".
```

## 10. 알고 시작하는 한계

- 서버 10개가 문서 검색 위주다. 쓰기·상태 변경 위험은 재지 않는다.
- eager 모드 숫자는 Claude Code 기본값의 현실이 아니다. deferred 정직성 런이 그 차이를 적는다.
- 태스크 20개는 통계적으로 얇다. 배치가 쌓여야 `savedPercent`의 분산이 의미를 가진다.
  `--summary`는 배치별 값과 가중 평균을 함께 낸다.
- `rare` 태스크가 서버당 1개라 regret 감지력이 낮다. 배치를 거듭하며 regret이 0으로만 나오면
  `rare` 비중을 늘린다.

## 11. 자체 검토

- 목표 문장의 모든 항목(K, M, B, A, P, S, R, E)이 7.3 장부 필드에 대응한다.
- 공유 계약(7절)은 T1~T3보다 먼저 이 문서에 확정됐고, T1·T2·T3의 쓰기 파일이 겹치지 않는다.
- 실서버·격리 DB를 만지는 T4만 직렬이고, T3 테스트는 픽스처만 쓴다.
- 판단이 갈리는 로직(verdict 접기, regret 원인, usage 대조, 익명화 조건)은 규칙과 테스트 단언으로
  못 박았다.
- 프롬프트 기록은 원문·해시·트랜스크립트 세 겹으로 남고, 사후 수정은 `--check`가 거부한다.
