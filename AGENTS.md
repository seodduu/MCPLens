# MCP Lens

Claude Code, Codex, Gemini CLI의 MCP 컨텍스트 회계 도구다. 툴 정의 토큰과 실제 사용량을 대조해 무엇을 끄면 얼마가 남는지 근거로 말한다.

- 설계의 유일한 진실: MCP-Lens-설계문서-v2.md
- 디자인 사양이 필요하면 루트 DESIGN.md를 먼저 만들고 유일한 진실로 삼는다. 그전까지는 MCP-Lens-설계문서-v2.md의 리포트·UI 절을 따른다.
- 구현 계획과 태스크·worktree 운영의 유일한 진실: docs/plans/

스택: TypeScript 모노레포, npm workspaces, Vitest, Node 20+, SQLite(~/.mcplens/lens.db), VS Code 확장, CLI, 로컬 대시보드, 클라이언트별 플러그인·훅 런타임.

## 계획·실행 스킬

- 설계 문서, 구현 계획, 태스크 분해, 실행 프롬프트를 만들거나 고칠 때는 plan-conventions를 먼저 읽는다.
- 구현 계획의 Wave, worktree, 서브에이전트, 통합, 실환경 E2E를 실행할 때는 execution-conventions를 먼저 읽는다.

## 모든 세션·서브에이전트 공통 규칙

- 자기 태스크의 Files 목록 밖 파일을 수정하지 않는다. packages/core/src/types.ts, packages/core/src/store/schema.sql, 루트 설정(package.json, tsconfig.base.json, vitest.config.ts)은 shared contract다. 불일치하면 수정하지 않고 보고한다.
- 계획서의 필드명과 fixture가 다르면 fixture를 진실로 삼아 코드를 맞춘다.
- 패키지는 서비스 경계다. core는 순수 로직·수집·저장만 담당하며 vscode를 import하지 않는다. extension, cli, dashboard, 플러그인은 core 공개 API를 경유하고 다른 패키지 내부 경로를 import하지 않는다.
- 비용·절감 수치는 core에서 계산한다. 클라이언트에는 판정을 바꾸지 않는 표시 형식만 맡긴다.
- 시점이 중요한 데이터는 snapshot으로 저장한다.
- DB 경로는 ~/.mcplens/lens.db이며 코드에서는 os.homedir()와 path.join()으로 조립한다. 물결표 문자열을 하드코딩하지 않는다.
- 네이티브 애드온을 추가하지 않는다. 원본 클라이언트 로그는 읽기 전용이며 파싱 실패는 throw하지 않고 건너뛰며 parseErrors를 증가시킨다.
- 시크릿은 코드·커밋에 넣지 않고 환경변수 또는 gitignore된 로컬 설정으로 주입한다.
- 유닛 테스트는 fixtures와 in-memory DB만 사용한다. 공유 DB나 실제 MCP 서버를 쓰는 스모크·E2E는 직렬 Wave로 분리한다.
- 화면을 만드는 태스크는 대시보드나 확장을 실제로 실행해 렌더 결과를 직접 스크린샷으로 확인하고 report에 경로를 남긴다. 리뷰어도 스크린샷을 직접 확인한다. 테스트나 curl은 이를 대체하지 못한다. 한글 본문에는 word-break: keep-all과 한글에 맞는 자간·행간을 적용한다.
- 커밋 메시지·문서·주석은 한국어로 쓰고, 커밋은 태스크 단위로 원자적으로 만든다.
- 완료를 주장하기 전에 해당 태스크의 테스트를 실행하고 출력을 확인한다.

## 일반 검증 함정

자세한 원문은 docs/pitfalls/에서 확인한다.

- 타입체크는 반드시 package별로 npx tsc --noEmit -p packages/<package>/tsconfig.json을 실행한다.
- 테스트 판정은 npm test를 기준으로 하며, 스모크·E2E spec은 Vitest 수집 범위에서 분리한다.
- fixture와 in-memory DB 테스트 통과만으로 실환경 동작을 주장하지 않는다.
- 성능·토큰 수 측정은 dist 배포 경로에서 수행하고 구성도 report에 기록한다.
- 화면 결함을 판정하기 전에 관련 빌드 산출물을 재생성하고 다시 확인한다.
- 새 worktree에서는 다른 무엇보다 먼저 node_modules를 해결한다. 설치본이 없으면
  packages/core/test/ingest/inbox.test.ts의 vite-node spawn이 ENOENT로 죽고, 이것이 5005ms
  타임아웃으로 보여 CPU 부하로 오진하기 쉽다.
- extension 타입체크 전에 npm run build -w @mcp-lens/core를 실행한다. extension은 core의
  dist 선언 파일을 본다.
- tsc는 테스트 파일을 보지 않는다. 스텁과 픽스처가 깨지는 것은 npm test만 잡는다.
- 실 DB에 쓰는 검증 전에 ~/.mcplens/backups/에 날짜를 붙인 사본을 남긴다.
- DB 라이터 리스가 거부되면 --extensionDevelopmentPath가 붙은 좀비 프로세스를 먼저 찾는다.
