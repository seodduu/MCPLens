# CLI

이 문서는 `mcp-lens`의 모든 명령을 정확한 플래그와 기본값까지 함께 정리한다. `--help`를
다시 실행하지 않아도 여기서 바로 찾을 수 있다. 처음부터 끝까지 한 번 돌려보려면
[빠른 시작](/ko/quick-start)를 보고, 리포트 열이 무엇을 뜻하는지는
[리포트 읽기](/ko/guide/reading-reports)를 본다.

모든 명령은 같은 진입점을 공유한다.

```
mcp-lens <command> [options]
```

`scan`과 `auth`만 데이터베이스에 쓰기 때문에, 이 둘만 writer lease를 잡고 VS Code 확장과
경합한다. `report`는 데이터베이스를 열지만 부수적인 로그 백필 외에는 쓰지 않는다. 확장이
lease를 쥐고 있으면 그 저장을 조용히 건너뛰고도 동일한 리포트를 읽기 전용으로 그대로
출력한다. writer lease가 왜 존재하는지는 [동작 원리](/ko/concepts/how-it-works)를 본다.

## report

```
mcp-lens report [--days <n>] [--format <f>]
```

비용 × 사용량 매트릭스를 출력한다. 스캔된 모든 툴의 정의 토큰 비용을 실제 호출 횟수와
나란히 놓고, 행마다 권장 조치를 붙인다. 이것이 기본 명령이라서 플레인 `mcp-lens`도 같은
동작을 한다.

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `--days <n>` | `30` | 최근 `n`일치만 집계한다. 0보다 큰 숫자여야 한다. |
| `--format <f>` | `table` | 출력 형식: `table`, `ai`, `json` 중 하나. |

```bash
mcp-lens report --days 14 --format table
```

표에는 열이 11개 있다. 블록을 짧게 유지하려고 실제 행 중 3개만 발췌했지만, 열은 전부
실제 그대로다.

```
server          tool                     defTokens  calls  respTokens  loaded/sessions  errorRate  errorTokens  action  confidence  reason
--------------  -----------------------  ---------  -----  ----------  ---------------  ---------  -----------  ------  ----------  ------------------------------------------------------------------------------------------------------------------------------------------
web-search      web-search_place_search  17251      0      0           0/533            -          0            remove  medium      definition 17,251 tokens, 0 calls. small savings, but cleans up the search space. 98 sessions/3d observed, confirmed with more observation
knowledge-base  knowledge-base-search    1809       10     124         5/533            0%         0            keep    high        called 10 times
weather-tools   get_weather              74         4      83          3/533            0%         0            keep    high        called 4 times

savings: potential=61893 actual=26839 saved=35054
(0 session files backfilled)
```

`--format ai`는 같은 데이터를 Markdown으로 출력하되, 행별 reason 템플릿을 중복 제거해서 표
위쪽 "Row reason templates" 절로 모아준다. 이것이 `/lens-audit` 슬래시 명령이 소비하는
형식이며, 어떤 툴을 끌지 LLM과 채팅하며 판단시키고 싶을 때 붙여넣기 좋은 형태이기도 하다.

## scan

```
mcp-lens scan [--config <path>]
```

설정된 모든 MCP 서버에 잠깐 연결해서 `tools/list`를 호출하고, 각 툴의 정의 토큰 수를
기록한다. LLM 토큰을 전혀 쓰지 않고, 클라이언트 설정 파일을 절대 편집하지 않는다.

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `--config <path>` | 감지된 모든 클라이언트 설정 | 모든 클라이언트 설정을 자동 탐색하는 대신, 이 설정 파일 하나만 읽고 스캔한다. |

```bash
mcp-lens scan
```

`discovered:` 줄은 설정 소스별로(`claude-user`, `claude-project`, `codex`, `gemini`) 몇 개의
서버가 발견됐는지 ` · `로 이어서 보여준다. 아래 예시는 실제 형식에 예시 수치를 넣은 것이다.

```
discovered: claude-user 2 · codex 1
- web-search: 9 tools, 26198 tokens
- knowledge-base: 15 tools, 24157 tokens
```

`scan`은 데이터베이스에 쓰기 때문에 writer lease를 잡는다. VS Code 확장이 현재 lease를
쥐고 있으면, 확장의 관측치를 덮어쓰는 대신 메시지를 출력하고 0이 아닌 상태 코드로 종료한다.

```
The VS Code extension is writing the MCP Lens DB, so this command cannot run right now.
Close the extension window (or the other running mcp-lens) and try again. It may also clear on its own shortly.
```

## auth

```
mcp-lens auth <serverName> [--clear]
```

HTTP MCP 서버 하나에 대해 OAuth 로그인을 실행한 뒤, 그 서버만 다시 스캔한다. `tools/list`가
성공하기 전에 로그인이 필요한 서버에 쓴다.

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `--clear` | off | 로그인하는 대신 `<serverName>`에 저장된 인증 정보를 삭제한다. |

```bash
mcp-lens auth github
```

```
github: login complete, 12 tools · 3410 tokens
```

`scan`과 마찬가지로 `auth`도 데이터베이스에 쓰면서 writer lease를 잡지만, 최종 저장 시점
근처에서만 그렇다. 브라우저 로그인 자체는 lease를 요청하기 전에 일어나므로, 로그인이 느려도
확장을 막지 않는다. 서버가 자동 클라이언트 등록을 거부하면(예를 들어 GitHub나 Figma의
원격 MCP 서버), 대신 OAuth 클라이언트 id를 설정할 설정 키나 개인 액세스 토큰용 헤더를
명령이 출력해 준다.

## hooks status

```
mcp-lens hooks status [--json]
```

클라이언트별 훅 설치 상태를 보여준다. 훅 패키지가 설치됐는지, trust 상태가 승인됐는지
(Codex 전용), 번들된 러너가 있는지, 마지막으로 관측된 훅 이벤트, 아직 대기 중인 이벤트
수, 전체 health를 표시한다.

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `--json` | off | 사람이 읽는 형식 대신 같은 데이터를 JSON으로 출력한다. |

```bash
mcp-lens hooks status
```

아래 필드명과 구조는 실제다(클라이언트당 한 블록, `client / package / trust / runner /
last event / pending / fallback / health`). 값은 예시일 뿐 실제로 캡처한 실행 결과가
아니다.

```
Claude Code
  package: installed
  trust: not-required
  runner: ready
  last event: <ISO timestamp of the most recent inbox event, or "none">
  pending: 0
  fallback: unknown
  health: idle
```

## hooks doctor

```
mcp-lens hooks doctor [client]
```

훅 설정을 진단하고 발견 사항마다 한 줄씩, 가장 심각한 것부터 출력한다. 클라이언트 이름을
넘기면 그 클라이언트만 검사한다.

| 인자 | 값 |
| --- | --- |
| `client` (선택) | `claude-code`, `codex`, `gemini-cli` |

```bash
mcp-lens hooks doctor codex
```

```
[WARNING] codex codex-trust-unapproved: Codex hook trust is not approved; review it with /hooks.
```

## hook capture

```
mcp-lens hook capture --client <c>
```

이것은 사람이 직접 실행하는 명령이 아니라 훅 런타임의 진입점이다. Claude Code, Codex,
Gemini CLI가 lifecycle hook으로 이것을 호출하며, 훅 payload를 stdin으로 흘려보낸다. payload를
디코드해서 관측 결과를 `~/.mcplens/inbox`에 큐잉하고, payload가 잘못됐거나 `--client`가
없거나 인식되지 않는 경우에도 항상 stdout에 `{}`를 출력하고 exit 0으로 끝난다. 이 fail-open
계약은 여기 버그가 있어도 코딩 세션을 절대 막지 않게 하기 위한 것이다.
