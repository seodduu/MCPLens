# 리포트 읽기

이 문서를 끝내면 `mcp-lens report`를 실행해 비용 × 사용량 매트릭스가 찍는 모든 열을 읽을 수
있다. 그 열을 근거로 어떤 툴을 끌지, 그러면 세션당 토큰이 얼마나 남는지 결정할 수 있는
상태가 된다.

## 리포트 실행

`report`는 CLI의 기본 명령이다. 인자 없이 실행하면 최근 30일치 매트릭스를 찍는다.

```bash
mcp-lens report
```

```
server          tool                                defTokens  calls  respTokens  loaded/sessions  errorRate  errorTokens  action         confidence  reason
--------------  ----------------------------------  ---------  -----  ----------  ---------------  ---------  -----------  -------------  ----------  ------
knowledge-base  knowledge-base-search               1809       10     124         5/533            0%         0            keep           high        called 10 times
web-search      web-search_web_search               1365       1      96          0/533            0%         0            keep           high        called 1 time
web-search      web-search_place_search             17251      0      0           0/533            -          0            remove         medium      definition 17,251 tokens, 0 calls. small savings, but cleans up the search space. 98 sessions/3d observed, confirmed with more observation
knowledge-base  knowledge-base-query-meeting-notes  5929       0      0           1/533            -          0            filter-server  high        Only 2 of 28 tools used on server knowledge-base. Tool filtering recommended. small savings, but cleans up the search space (loaded but never called, so it pollutes the search space). 441 sessions/19d observed, accumulated cost 2,614,689 tokens. Restorable with one config line

savings: potential=61893 actual=26839 saved=35054
```

이 발췌는 실제 행 중 4개와 요약 줄만 남기되, 캡처 원본의 `defTokens` 내림차순이 아니라
keep/remove/filter-server 순서로 재배열했다. 즉 이것은 한 번의 실행을 그대로 찍은 출력이
아니다. 서버명과 툴명은 자리표시자이고, 그 외 숫자·열·행은 캡처된 그대로다. 실제 실행은
관측된 툴마다 한 행을 찍고 `defTokens` 내림차순으로 정렬한다. 다른 프로세스(보통 VS Code
확장)가 같은 순간 데이터베이스에 쓰고 있어도 `report`는 여전히 같은 출력을 찍는다. 다만
그때는 읽기 전용으로 동작한다. 아래
[writer lease에 대한 참고](#writer-lease에-대한-참고)를 본다.

## 열 읽기

| 열 | 의미 |
|---|---|
| `server` / `tool` | MCP 서버와 툴 이름. 자기 클라이언트 설정이 부르는 이름 그대로다. |
| `defTokens` | 서버가 붙어 있는 한 매 프롬프트마다 그 툴의 정의(JSON 스키마)가 소모하는 토큰. `-`는 `mcp-lens scan`이 아직 이 툴을 측정하지 않았다는 뜻이다. |
| `calls` | 관측 구간 동안 이 툴이 실제로 호출된 횟수. |
| `respTokens` | 성공한 호출이 반환한 토큰을 구간 동안 합산한 값. |
| `loaded/sessions` | 정의가 로드된 세션 수(지연/lazy 툴 로딩을 쓰는 클라이언트에만 의미가 있다)를 관측된 전체 세션 수 대비로 나타낸 값. |
| `errorRate` / `errorTokens` | 호출 중 에러가 난 비율, 그리고 그 실패한 호출에 쓰인 응답 토큰. `calls`가 0이면 `-`다. 호출된 적 없는 툴은 신뢰성을 매길 수 없다. |
| `action` | 권장 조치. `keep`, `remove`, `filter-server`, `inspect`, `unknown` 중 하나다. |
| `confidence` | `high`, `medium`, `low`. 그 조치를 뒷받침하는 관측이 얼마나 되는지를 나타낸다. |
| `reason` | 한 문장으로 된 이유. `action`과 `confidence`를 뒷받침하는 근거다. |

## 한 행에서 결정으로

매트릭스가 답하는 핵심 질문은 "무엇을 끄고 얼마가 남는가"다. 그 세션에 그 툴을 호출했는지와
무관하게 매 프롬프트마다 지불하는 값이므로 `defTokens`를 먼저 읽고, 그다음 `calls`를 확인해
쓰지도 않는 것에 돈을 내고 있는지 본다.

- `keep`: 관측 구간 동안 호출됐다. 그대로 붙여 둔다.
- `remove`: `defTokens`는 지불했는데 `calls`가 0이다. `reason`이 지금까지 누적된 비용을
  적는다. 예를 들어 위 `web-search_place_search` 행은 세션당 17,251 토큰인데 한 번도
  호출되지 않았다.
- `filter-server`: 한 서버의 툴 중 극히 일부만 호출된다(위 `knowledge-base` 행은 28개 중
  2개). 서버 전체가 아니라 쓰지 않는 개별 툴만 끄는 쪽을 권장한다.
- `inspect`: 실패가 잦아서 결정하기 전에 살펴볼 가치가 있는 툴이다.
- `unknown`: 스캐너가 아직 이 툴의 정의 토큰을 훑지 않았다.

맨 아래 `savings` 줄은 전체 행을 합산한 값이다. `potential`은 모든 툴을 다 붙였을 때의
비용, `actual`은 오늘 실제로 지불하는 비용, `saved`는 `potential - actual`로 앞서 제거한
툴 덕분에 이미 회수된 토큰이다.

무엇을 끌지 정했다면, [전역 조치](/ko/guide/global-actions) 문서가 `remove`나
`filter-server` 권장을 Claude Code나 Codex의 실제 설정 변경으로 바꾸는 방법을 다룬다.

## 시간 창 바꾸기

`--days`는 최근 *n*일치만 집계한다. 기본값은 30이고 양수여야 한다. 예를 들어
`mcp-lens report --days 7`. 표의 형태와 열은 그대로이고, `calls`, `respTokens`,
`errorRate`/`errorTokens`, `savings` 줄만 그 창으로 좁혀진다.

잘못된 값은 기본값으로 조용히 대체되지 않고 거부된다.

```bash
mcp-lens report --days 0
```

```
invalid --days value: "0"
Pass a number greater than 0 (e.g. --days 30).
```

## AI에 붙여넣을 형식

`--format ai`는 같은 매트릭스를 압축된 Markdown으로 찍는다. 반복되는 reason 텍스트는
공유 basis와 번호 붙은 템플릿으로 빼내어 매 행마다 반복하지 않는다. Claude, Codex,
그 외 어떤 어시스턴트든 채팅에 그대로 붙여넣어 "이 중 무엇을 꺼야 하는지" 물어보는 용도로
만들어졌다.

```bash
mcp-lens report --format ai
```

```markdown
# MCP Lens Audit

potential tokens 61893 / actual tokens 26839 / savable tokens 35054

## Shared server basis
- knowledge-base: Only 2 of 28 tools used on server knowledge-base. Tool filtering recommended.

## Row reason templates
- T2: small savings, but cleans up the search space (loaded but never called, so it pollutes the search space). 441 sessions/19d observed, accumulated cost {cost} tokens. Restorable with one config line

| server | tool | defTokens | calls | respTokens | loaded/sessions | errorRate | errorTokens | action | confidence | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| knowledge-base | knowledge-base-search | 1809 | 10 | 124 | 5/533 | 0% | 0 | keep | high | called 10 times |
| knowledge-base | knowledge-base-query-meeting-notes | 5929 | 0 | 0 | 1/533 | - | 0 | filter-server | high | T2 (accumulated cost 2,614,689 tokens) |

## Recommendations
- [filter-server·high] knowledge-base/knowledge-base-query-meeting-notes: T2 (accumulated cost 2,614,689 tokens) (measured)
```

이 블록도 발췌다. 같은 방식으로 잘라냈고 자리표시자 이름도 동일하다. 실제 실행은 basis와
템플릿 표기법을 설명하는 "How to read" 문단으로 시작하고, 필요했던 모든 reason 템플릿을
싣고(이 결과를 만든 실행은 T1부터 T12까지 만들어냈다), 관측된 툴마다 표 행 하나와 추천
하나를 나열하고, "Candidates (not enough observation)"와 "Failing tools to inspect" 절로
끝난다.

`mcp-lens report --format json`은 같은 행과 `savings` 객체를 하나의 JSON 문서
(`{ "rows": [...], "savings": {...} }`)로 찍는다. 스크립팅용이다. 각 행은 위 표의 열과
같은 필드에 더해 권장의 근거 전체를 담는다.

지원하지 않는 값은 `--days`와 같은 방식으로 거부된다.

```bash
mcp-lens report --format csv
```

```
invalid --format value: "csv"
Pass one of table, ai, json.
```

## writer lease에 대한 참고

`scan`과 `auth`는 데이터베이스에 쓰고, 한 번에 한 프로세스만 쥘 수 있는 writer lease를
잡는다. VS Code 확장이 그것을 쥐고 있는 동안은 실행을 거부한다. `report`는 쓸 필요가 없으므로
항상 실행되며, lease를 잡을 수 있을 때는 작은 백필을 저장하고, 잡을 수 없을 때는 완전히
읽기 전용으로 남는다. 출력은 어느 쪽이든 동일하다.

같은 매트릭스와 같은 열이 어떤 명령도 실행하지 않고 VS Code 안에도 그대로 나타난다.
[VS Code 확장](/ko/guide/vscode-extension) 문서를 본다. 그 수치 자체가 어떻게 수집되고
계산되는지는 [동작 원리](/ko/concepts/how-it-works) 문서를 본다.
