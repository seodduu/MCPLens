# MCP Lens Claude Code 플러그인

Claude Code의 공식 lifecycle hook으로 MCP 호출 메타데이터를 로컬 수집하고,
`/lens-audit` 슬래시 커맨드로 MCP 툴 컨텍스트 낭비 감사를 실행하는 플러그인입니다.

## 로컬 hook 수집

플러그인에 포함된 `scripts/hook-runner.mjs`와 `runtime/`만 사용합니다. Hook은
stdin payload를 읽고 MCP 호출의 클라이언트·세션·서버·툴·시각 같은 최소 메타데이터만
`~/.mcplens/inbox`에 원자적으로 기록합니다. `tool_input`, `tool_response`, 프롬프트와
응답 본문은 저장하지 않으며 네트워크나 MCP Lens DB를 열지 않습니다. 정상 stdout은
항상 `{}`뿐이고 차단 결정을 반환하지 않습니다.

설치 또는 업데이트 뒤에는 Claude Code 플러그인을 reload하고 새 세션을 시작해야 hook
정의가 적용됩니다. 수집을 끄려면 플러그인을 disable하거나 uninstall한 뒤 새 세션을
시작하십시오. MCP Lens는 Claude의 원본 transcript/log를 수정하거나 이동하지 않습니다.

## 동작

`/lens-audit`은 아래 명령을 실행해 리포트를 컨텍스트에 올린다:

```bash
npx --no-install mcp-lens report --days 30 --format ai
```

출력 계약: 첫 줄이 `# MCP Lens Audit`인 AI 소비용 마크다운 리포트 (Task 10 CLI가 제공).

### CLI 의존성과 `--no-install`

이 플러그인은 CLI를 번들하지 않는다. 훅 수집 런타임만 자급자족이고, `/lens-audit`은
별도로 설치된 `mcp-lens` 실행 파일을 필요로 한다.

`--no-install`은 보안상 필수다. 이 저장소의 CLI는 미발행 패키지 `@mcp-lens/cli`이고
bin 이름만 `mcp-lens`인데, npm 레지스트리에는 이 프로젝트와 무관한 동명 패키지가 실존한다.
`--no-install` 없이 `npx mcp-lens`를 돌리면 로컬에 bin이 없는 환경에서 그 서드파티 코드가
자동으로 내려받아져 실행된다. `--no-install`은 로컬 확인만 하고 레지스트리 조회를 하지 않는다.

CLI가 없으면 커맨드는 동작하지 않는다. 설치 방법은 다음과 같다.

```bash
# 저장소를 클론한 경우 (저장소 루트에서)
npm install && npm run build

# 저장소 밖에서도 쓰려면 전역 bin 연결
npm link -w @mcp-lens/cli
```

CLI를 따로 두고 싶지 않다면 VS Code 확장(MCP Context Lens)이 같은 데이터를 사이드바에서
보여주므로 그쪽을 쓰면 된다.
리포트를 바탕으로 Claude가 다음을 수행한다:

1. 제거 권장(remove) 툴 표 요약 + 예상 절약 토큰
2. filter-server 권고 시 클라이언트 설정에서의 구체적 필터링 방법 제안
3. 근거 라벨(실측/하한 추정/전량 가정) 표기로 숫자 신뢰 수준 명시
4. 사용자 동의 시 설정 수정 지원 (수정 전 반드시 백업)

## 설치 (로컬)

```bash
claude plugin add /path/to/MCPLens-V2/packages/lens-audit-plugin
```

또는 마켓플레이스 등록 없이 `--plugin-dir`로 로드해 테스트할 수 있다.

## 구조

```
packages/lens-audit-plugin/
├── .claude-plugin/plugin.json   # 플러그인 매니페스트
├── commands/lens-audit.md       # /lens-audit 커맨드 정의
├── hooks/hooks.json             # lifecycle hook 등록
├── scripts/hook-runner.mjs      # 번들 진입점
├── runtime/                     # dependency-free 로컬 capture runtime
└── README.md
```

## 권한

커맨드 프론트매터는 `allowed-tools: Bash(npx --no-install mcp-lens:*)`이다. 즉
`npx --no-install mcp-lens` 하위 명령만 사전 허용하며, 레지스트리 자동 설치를 동반하는
형태(`npx mcp-lens ...`)는 이 패턴에 걸리지 않는다.

## 검증 상태

실행 검증(`/lens-audit` → CLI 호출 → 요약 확인)은 CLI(Task 10) 머지 이후에만 가능하므로
Wave 4 실기기 스모크에서 수행한다.
