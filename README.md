# MCP Lens

AI 코딩 클라이언트에 붙인 MCP 서버가 **매 프롬프트마다 얼마나 많은 컨텍스트를 먹고 있는지**,
그리고 **그중 실제로 쓰이는 것은 무엇인지**를 대조하는 로컬 회계 도구입니다.

MCP 서버를 하나 붙이면 그 서버의 툴 정의 전체가 대화마다 프롬프트에 실립니다. 툴이 40개인
서버를 붙여 두고 그중 2개만 쓰고 있어도 나머지 38개의 정의 토큰은 매번 지불됩니다. MCP Lens는
정의가 먹는 토큰(비용)과 실제 호출 횟수(사용)를 나란히 놓고, "무엇을 끄면 얼마가 남는가"를
숫자로 말합니다. 추측이 아니라 실제로 스캔한 정의 크기와 실제로 관측된 호출 기록이 근거입니다.

## 지원 클라이언트

| 클라이언트 | 사용량 수집 | 정의 스캔 | 전역 조치(설정에서 툴 끄기) |
|---|---|---|---|
| Claude Code | O (플러그인 훅) | O | O |
| Codex | O (플러그인 훅) | O | O |
| Gemini CLI | O (확장 훅) | O | X |

## 요구 사항

- Node.js 20 이상
- VS Code 1.90 이상 (확장을 쓰는 경우)

## 설치

### 1. VS Code 확장 (주 배포 경로)

대부분의 사용자에게 권장하는 경로입니다. 스캔, 훅 설치, 리포트, 의존성 분석이 모두 확장 안에
있어서 CLI를 따로 설치하지 않아도 됩니다.

`.vsix`를 직접 빌드해 설치합니다.

```bash
git clone https://github.com/seodduu/MCPLens-V2.git
cd MCPLens-V2
npm install
npm run build
npm run package -w mcp-context-lens     # packages/extension/*.vsix 생성
code --install-extension packages/extension/mcp-context-lens-<버전>.vsix
```

설치 후 VS Code를 다시 열면 온보딩 워크스루가 열립니다. 워크스루의 4단계(스캔 → 훅 설치 →
의존성 분석 → 전역 조치 활성화)를 따라가면 됩니다. 활동 표시줄의 MCP Lens 아이콘에서
`Cost × Usage Matrix`와 `Setup Status` 두 뷰를 볼 수 있습니다.

### 2. 훅·플러그인 설치 (사용량 수집)

정의 스캔만으로는 "이게 얼마나 비싼가"까지만 알 수 있습니다. "실제로 쓰이는가"를 알려면
클라이언트에 훅을 설치해야 합니다.

가장 쉬운 방법은 확장의 `MCP Lens: Install Hooks for All Clients` 커맨드입니다. 확장이
클라이언트별 설치 절차를 대신 수행합니다. 설치 뒤 각 클라이언트에서 다음이 필요합니다.

- **Claude Code**: 플러그인을 reload하고 새 세션을 시작합니다.
- **Codex**: `/hooks`에서 MCP Lens 훅 정의를 검토하고 현재 해시를 신뢰 처리해야 훅이
  실행됩니다. 그 뒤 새 세션을 시작합니다.
- **Gemini CLI**: Gemini CLI를 재시작합니다.

수동으로 설치하려면 각 패키지의 README를 따르십시오.

- `packages/lens-audit-plugin/` (Claude Code 플러그인, `/lens-audit` 슬래시 커맨드 포함)
- `packages/codex-plugin/` (Codex 플러그인)
- `packages/gemini-extension/` (Gemini CLI 확장)

훅은 자급자족입니다. 런타임을 내려받지 않고, 네트워크를 쓰지 않으며, Lens DB를 열지 않습니다.
`~/.mcplens/inbox`에 메타데이터를 원자적으로 적어 두면 확장이나 CLI가 그것을 DB로 옮깁니다.
정상 stdout은 항상 `{}`이고 어떤 경우에도 클라이언트의 동작을 차단하지 않습니다.

### 3. CLI (선택)

CLI는 npm에 발행돼 있지 않습니다. 저장소를 빌드한 뒤 워크스페이스 bin으로 쓰거나
`npm link`로 연결합니다.

```bash
npm install && npm run build
npm link -w @mcp-lens/cli      # 저장소 밖에서도 mcp-lens를 쓰고 싶을 때만
```

> 레지스트리에 이 프로젝트와 무관한 동명 패키지 `mcp-lens`가 존재합니다. `npx mcp-lens`를
> 그냥 실행하면 로컬에 bin이 없을 때 그 서드파티 패키지가 내려받아져 실행됩니다.
> 항상 `npx --no-install mcp-lens` 형태로 쓰거나 위처럼 링크한 bin을 직접 부르십시오.

## CLI 사용법

```
mcp-lens <command> [options]
```

| 커맨드 | 하는 일 |
|---|---|
| `report` | 수집된 관측으로 비용×사용 매트릭스를 출력합니다. 인자가 없을 때의 기본 커맨드입니다. |
| `report --days <n>` | 최근 n일만 집계합니다 (기본 30). |
| `report --format <f>` | 출력 형식을 고릅니다: `table`(기본), `ai`, `json`. |
| `scan` | 설정된 MCP 서버에 잠깐 접속해 툴 정의와 토큰 수를 스캔하고 저장합니다. |
| `scan --config <path>` | 감지된 모든 클라이언트 설정 대신 이 설정 파일 하나만 읽습니다. |
| `auth <serverName>` | http 서버에 OAuth 로그인한 뒤 그 서버만 재스캔합니다. |
| `auth <serverName> --clear` | 저장된 인증 정보를 지웁니다. |
| `hooks status [--json]` | 클라이언트별 훅 설치 상태를 봅니다. |
| `hooks doctor [client]` | 훅 설정을 진단합니다 (`claude-code`, `codex`, `gemini-cli`). |
| `hook capture --client <c>` | 훅 런타임 진입점입니다. stdin으로 페이로드를 받으며 사람이 직접 쓰지 않습니다. |

예시:

```bash
mcp-lens scan                          # 정의 토큰 수집
mcp-lens report --days 30              # 최근 30일 비용×사용 매트릭스
mcp-lens report --format ai            # AI가 읽기 좋은 마크다운 리포트
mcp-lens hooks doctor codex            # Codex 훅이 왜 안 잡히는지 진단
```

`scan`은 각 stdio 서버를 잠깐 띄워 `tools/list`를 부르는 것이 전부입니다. LLM 토큰을 쓰지 않고
클라이언트 설정 파일을 고치지도 않습니다.

## 대시보드 (동결됨)

로컬 웹 대시보드는 **동결 상태**입니다. 코드와 테스트는 유지되지만 신규 기능은 반영하지
않습니다. VS Code 사이드바가 그 역할을 흡수했기 때문입니다. 동결 시점 기준으로는 동작합니다.

```bash
npm run build -w @mcp-lens/dashboard
npm start -w @mcp-lens/dashboard       # http://127.0.0.1:43117
```

## 데이터와 프라이버시

모든 데이터는 로컬에만 있습니다. 저장 위치는 `~/.mcplens/lens.db`(SQLite)이고, 훅이 넘기는
중간 큐는 `~/.mcplens/inbox`입니다.

**수집하는 것**: 세션·턴·호출 ID, 클라이언트 이름, MCP 서버 이름과 툴 이름, 관측 시각,
호출 소요 시간(`durationMs`), 오류 여부(`isError`), 스캔한 툴 정의의 토큰 수.

**수집하지 않는 것**: 대화 본문, 프롬프트, 툴 입력(`tool_input`), 툴 응답(`tool_response`),
어시스턴트 응답 본문, 소스 코드.

원본 클라이언트 로그는 읽기 전용으로만 다룹니다. 수정하거나 옮기지 않습니다.

의존성 분석(`MCP Lens: Analyze Dependencies`)만은 예외적으로 외부 LLM을 호출합니다. 이때도
전송되는 것은 툴 정의와 집계된 사용 횟수뿐이며, 실행 전에 전송 범위와 예상 비용을 고지하고
동의를 받습니다. 동의는 `MCP Lens: Withdraw Inference Consent`로 철회할 수 있습니다.
전역 조치(설정 파일을 고쳐 툴을 끄는 기능)는 기본값이 잠김이고,
`mcplens.dependencyAnalysis.rollout` 설정으로 명시적으로 허용해야 동작합니다.

## 알려진 제약

- **확장이 실행 중일 때 CLI 스캔을 동시에 돌리지 마십시오.** DB에는 한 번에 한 writer만
  붙어야 하는데, CLI는 확장이 쓰는 writer lease에 참여하지 않는 구성이었습니다. 둘이 동시에
  쓰면 한쪽의 기록이 조용히 덮여 유실될 수 있습니다. CLI `scan`/`auth`를 쓸 때는 VS Code를
  닫거나 확장을 비활성화하십시오. (CLI가 lease를 잡도록 하는 수정이 진행 중입니다.
  적용된 뒤에는 확장이 살아 있으면 CLI `scan`/`auth`가 아예 거부됩니다. `report`는 읽기
  전용이라 언제든 안전합니다.)
- 원본 클라이언트 로그는 대략 30일이면 만료됩니다. Lens DB는 그 뒤에도 데이터를 유지하므로
  더 긴 기간도 조회할 수 있지만, Lens를 설치하기 전 기간은 소급해서 채울 수 없습니다.
- 전역 조치는 Claude Code와 Codex만 지원합니다. Gemini CLI는 대상이 아닙니다.
- 대시보드는 동결 상태입니다. 위 "대시보드" 절을 보십시오.

## 개발

```bash
npm install
npm run build
npm test                # vitest (packages/*/test/**/*.test.ts)
npx tsc --noEmit -p packages/core/tsconfig.json      # 타입체크는 반드시 패키지별 -p로
```

루트 tsconfig는 references 구조라서 `npx tsc --noEmit`을 인자 없이 돌리면 0개 파일을 검사하고
성공합니다. 거짓 녹색이므로 항상 `-p`로 패키지를 지정하십시오.

## 문서

- [`MCP-Lens-설계문서-v2.md`](MCP-Lens-설계문서-v2.md): 도메인, 수집 규약, 범위의 유일한 진실
- [`docs/plans/`](docs/plans/): 구현 계획서
- [`docs/pitfalls/`](docs/pitfalls/): 이 스택에서 반복해서 밟은 함정
- [`docs/BACKLOG.md`](docs/BACKLOG.md): 백로그
- [`docs/SMOKE.md`](docs/SMOKE.md): 실환경 스모크 절차
- [`CLAUDE.md`](CLAUDE.md): 에이전트 실행 규약

## 라이선스

MIT. [`LICENSE`](LICENSE)를 보십시오.
