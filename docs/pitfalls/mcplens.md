# MCP Lens에서 직접 밟은 함정

`workflow.md`·`frontend-react.md`·`backend-spring.md`는 다른 프로젝트에서 가져온 원문이라
그대로 보존한다. 이 파일은 이 저장소에서 실제로 밟은 것만 적는다.
각 항목은 "증상 → 원인 → 처방" 순서다.

## 새 worktree에서 inbox 테스트가 vite-node ENOENT로 죽는다

**증상:** 갓 만든 worktree에서 `npm test`를 돌리면 `packages/core/test/ingest/inbox.test.ts`
4건이 실패한다. 3건은 5005ms 타임아웃이고, 출력에 `Errors 22 errors`가 붙는다.
같은 커밋을 공유 체크아웃에서 돌리면 24건 전부 통과한다.
`@mcp-lens/core` 미해결로 15개 파일이 `0 test`가 되는 증상이 함께 나기도 한다.

**원인:** `inbox.test.ts`는 락 경합과 만료를 실제로 검증하려고
`join(process.cwd(), 'node_modules', '.bin', 'vite-node')`를 20개 프로세스로 spawn한다.
`node_modules`는 gitignore 대상이라 새 worktree에는 설치본이 없다.
spawn이 `ENOENT`로 죽고, 자식이 시작조차 못 하니 부모가 기다리다 타임아웃으로 끝난다.
tmpdir 격리는 되어 있으므로 병렬 실행 자체는 문제가 아니다.

**처방:**
- worktree 진입 직후, 다른 무엇보다 먼저 `node_modules`를 해결한다. 루트 설치본으로
  심링크를 걸거나 `npm install` + `npm run build`를 한다.
- `npm install`이 `package-lock.json`을 바꾸면 커밋 전에 되돌린다. 태스크 범위 밖이다.
- 실행 프롬프트 1단계에 이 지시를 넣는다. 2026-08-08 웨이브에서 병렬 터미널 4개가
  **전부** 이것에 걸렸고, 네 세션이 각자 "기존 결함"으로 오진해 보고하는 비용을 냈다.

**오진 주의:** 타임아웃이 보이면 CPU 병렬 부하로 착각하기 쉽다. 오케스트레이터가 실제로
그렇게 오진해 두 세션에 잘못된 판정을 보냈다. 부하와 ENOENT를 가르는 것은 출력에 실제로
`ENOENT`와 spawn 경로가 찍히는지다. 부하를 의심하기 전에 그 줄을 먼저 찾아라.

## extension의 tsc는 core의 dist를 본다

**증상:** `packages/core`의 타입을 좁히거나 필드를 필수로 바꾼 뒤
`npx tsc --noEmit -p packages/extension/tsconfig.json`을 돌리면, 소스는 이미 맞는데
없어야 할 에러가 난다. 반대로 core 쪽을 깨뜨렸는데 extension이 녹색으로 나오기도 한다.

**원인:** extension은 core의 소스가 아니라 `packages/core/dist`의 선언 파일을 참조한다.
core를 다시 빌드하지 않으면 extension이 낡은 계약을 보고 판정한다.

**처방:** extension 타입체크 전에 `npm run build -w @mcp-lens/core`를 먼저 돌린다.
DoD에 두 줄을 순서대로 적는다. 이것은 `tsc -p` 누락과는 다른 별개의 거짓 신호다.

## tsc는 테스트 파일을 보지 않는다

**증상:** `tsc -p` 두 개가 전부 exit 0인데 `npm test`에서 기존 테스트가 깨진다.

**원인:** 스텁과 픽스처는 타입체크 대상이 아니다. 프로덕션 코드가 store에 새 메서드를
요구하게 되면 가짜 store 스텁이 `... is not a function`으로 터지고, 페이로드에 필드를
추가하면 deep-equal 픽스처가 어긋난다. tsc는 둘 다 못 잡는다.

**처방:** 판정 기준은 항상 `npm test`다. 인터페이스를 넓힌 태스크는 소유 범위 밖이라도
스텁·픽스처 수정이 따라온다는 것을 계획서에 미리 적고, 그 수정은 사양 변경이 아니라
배선의 필연적 귀결로 승인한다.

## 좀비 Extension Development Host가 DB 라이터 리스를 쥔다

**증상:** `mcp-lens scan`이
`The VS Code extension is writing the MCP Lens DB, so this command cannot run right now.`로
거부된다. 사용자에게 물어도 편집기를 닫은 상태다.

**원인:** 며칠 전 디버깅으로 띄운 Extension Development Host가 그대로 살아 10초마다
`~/.mcplens/db-writer.lock`을 갱신하고 있었다. 사용자가 쓰는 창이 아니었다.

**처방:** 리스 거부를 만나면 사용자 창을 의심하기 전에
`--extensionDevelopmentPath`가 붙은 프로세스를 찾는다. 그것이면 사용자에게 알리고
승인을 받아 그 프로세스만 종료한다. 사용자가 실제로 작업 중인 창은 임의로 닫지 않는다.
검증이 끝나면 자기가 띄운 dev host도 반드시 닫는다. 안 닫으면 다음 사람이 같은 함정을 밟는다.

## 실 DB에 쓰는 검증은 백업을 먼저 만든다

**증상:** 없다. 사고가 나기 전에 적어 둔다.

**원인:** 스캔·분석 검증은 `~/.mcplens/lens.db`를 실제로 바꾼다.
스크래치패드에 뜬 백업은 세션이 끝나면 사라질 수 있다.

**처방:** 실 DB에 쓰는 검증 전에 사본을 `~/.mcplens/backups/`처럼 세션과 무관한 곳에
날짜를 붙여 남긴다. 읽기만 하는 검증은 사본에서 한다.
2026-08-08 W3 검증본은 `~/.mcplens/backups/lens-2026-08-08-pre-realscan.db`에 있다.
