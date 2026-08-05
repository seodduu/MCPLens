// packages/cli/src/help.ts

export const HELP_TEXT = `mcp-lens — MCP 컨텍스트 회계 도구

사용법: mcp-lens <command> [options]

커맨드
  report                    수집된 관측으로 비용×사용 매트릭스를 출력한다 (기본 커맨드)
      --days <n>            최근 n일만 집계한다 (기본 30, 0보다 큰 숫자)
      --format <f>          출력 형식: table | ai | json (기본 table)
  scan                      설정된 MCP 서버에 접속해 툴 정의와 토큰 수를 스캔·저장한다
      --config <path>       이 설정 파일 하나만 읽는다 (기본: 감지된 모든 클라이언트 설정)
  auth <serverName>         http 서버에 OAuth 로그인한 뒤 그 서버만 재스캔한다
      --clear               저장된 인증 정보를 지운다
  hooks status              클라이언트별 훅 설치 상태를 본다
      --json                JSON으로 출력한다
  hooks doctor [client]     훅 설정을 진단한다 (client: claude-code | codex | gemini-cli)
  hook capture --client <c> 훅 런타임 진입점. stdin으로 페이로드를 받는다 (사람이 직접 쓰지 않는다)

  -h, --help                이 도움말을 출력한다

메모
  scan과 auth는 DB에 쓰므로 writer lease를 잡는다. VS Code 확장이 실행 중이면
  실행되지 않으니 확장을 닫고 다시 시도하라. report는 리스를 잡으면 백필까지 저장하고,
  못 잡으면 읽기 전용으로 진행한다(출력 내용은 같다).
`;

/**
 * 도움말 요청인지 판정한다.
 *
 * `hook`은 절대 여기서 가로채지 않는다. `mcp-lens hook capture`는 클라이언트 세션이
 * 깨지지 않도록 어떤 인자에도 stdout으로 `{}`를 내고 exit 0 해야 하는 fail-open 계약이라,
 * 도움말이 그 경로를 대신 처리하면 훅 호스트가 깨진다.
 */
export function isHelpRequest(args: string[]): boolean {
  if (args[0] === 'hook') return false;
  if (args.length === 0) return true;
  if (args[0] === 'help') return true;
  return args.some((a) => a === '--help' || a === '-h');
}
