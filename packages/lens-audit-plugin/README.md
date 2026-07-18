# MCP Lens `/lens-audit` 플러그인

Claude Code에서 `/lens-audit` 슬래시 커맨드로 MCP 툴 컨텍스트 낭비 감사를 실행하는 플러그인.

## 동작

`/lens-audit`은 아래 명령을 실행해 리포트를 컨텍스트에 올린다:

```bash
npx mcp-lens report --days 30 --format ai
```

출력 계약: 첫 줄이 `# MCP Lens Audit`인 AI 소비용 마크다운 리포트 (Task 10 CLI가 제공).
리포트를 바탕으로 Claude가 다음을 수행한다:

1. 제거 권장(remove) 툴 표 요약 + 예상 절약 토큰
2. filter-server 권고 시 클라이언트 설정에서의 구체적 필터링 방법 제안
3. 근거 라벨(실측/하한 추정/전량 가정) 표기로 숫자 신뢰 수준 명시
4. 사용자 동의 시 설정 수정 지원 (수정 전 반드시 백업)

## 설치 (로컬)

```bash
claude plugin add /path/to/MCPLens/packages/lens-audit-plugin
```

또는 마켓플레이스 등록 없이 `--plugin-dir`로 로드해 테스트할 수 있다.

## 구조

```
packages/lens-audit-plugin/
├── .claude-plugin/plugin.json   # 플러그인 매니페스트
├── commands/lens-audit.md       # /lens-audit 커맨드 정의
└── README.md
```

## 권한

커맨드 프론트매터의 `allowed-tools: Bash(npx mcp-lens *)` — `npx mcp-lens` 하위 명령만 허용한다.

## 검증 상태

실행 검증(`/lens-audit` → CLI 호출 → 요약 확인)은 CLI(Task 10) 머지 이후에만 가능하므로
Wave 4 실기기 스모크에서 수행한다.
