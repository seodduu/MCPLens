# 운용 함정 (worktree / 병렬 웨이브 / 검증)

## 계획서·참조 문서는 worktree에 저절로 딸려가지 않는다

worktree는 커밋된 것만 가져간다. 계획서가 untracked면, 또는 계획서 경로 자체가 gitignore
대상이면(`docs/plans/` 등을 원격에 안 올리는 저장소) 새 worktree에는 계획서도 설계 문서도
없다. 서브에이전트가 "참조 문서가 없다"며 기점 검증에서 멈춘다.
worktree 생성 직후 `cp -R`로 계획서·참조 문서·로컬 설정(`.env`,
`application-local.yml`)을 복사하는 지시를 실행 프롬프트 1단계에 넣는다.
작업 후 worktree 안에서 고친 문서는 루트로 되돌려 복사한다. 머지로는 안 따라온다.
(자세한 규칙은 `skills/plan-conventions/SKILL.md`)

## E2E는 전용 프로필 백엔드로 돌린다

외부 결제(토스 등) 통합이 있으면 compose 백엔드(시크릿 빈 값)로 E2E를 돌릴 때 실 게이트웨이
401이 나서 거짓 적신호가 뜬다. `@Profile("e2e")`의 Fake 게이트웨이를 활성화한 백엔드를
따로 띄워서 돌린다. 시드 계정의 장바구니 잔여물 같은 상태 가정도 스펙에 있으므로,
수동 검증으로 어지럽힌 상태는 돌리기 전에 초기화한다.

## 웨이브 마감 curl 스모크 절차 (패턴)

통합테스트(Testcontainers)는 마이그레이션과 validate만 본다. 시드 데이터로 API를 curl하려면
앱을 실제로 띄워야 한다. 패턴:
1. 임시 DB 컨테이너를 비표준 호스트 포트에 띄운다 (`docker run ... -p 13306:3306 mysql:8.4`).
2. DB 접속 정보와 시크릿(Base64 JWT 등)을 환경변수로 넘겨 bootRun. default 프로필이
   Flyway + 시드를 적용하게 한다.
3. 기능 플래그 기본값이 off인 구성(이벤트 릴레이, 캐시 등)은 검증 대상이면 명시적으로 켠다.
   조용히 꺼진 채 "정상"으로 보이는 게 이 단계의 함정이다.
4. 끝나면 프로세스와 컨테이너를 정리한다.

## 화면 태스크의 완료 조건은 스크린샷이다

유닛테스트 수십 개와 curl이 전부 녹색이어도 히어로 줄바꿈 깨짐, 빈 레이아웃 같은 시각
결함은 그대로 남는다. 구현 서브에이전트가 개발서버를 띄우고 담당 화면을 스크린샷으로 찍어
직접 본 뒤 파일 경로를 보고서에 남기고, 리뷰어도 그 스크린샷을 열어보고 판정한다.

## 도구가 만드는 거짓 신호 목록 (판정 전에 의심할 것)

같은 계열의 함정이 반복됐다. "테스트/도구가 빨간데 앱이 정상" 또는 그 반대가 의심되면
코드를 고치기 전에 이 목록부터 확인한다.

| 거짓 신호 | 원인 | 진실 기준 |
|---|---|---|
| tsc 녹색 | `-p` 누락으로 0파일 검사 | `tsc --noEmit -p tsconfig.app.json` |
| vitest 1 failed | e2e 스펙 오수집 | `npm test` (exclude 설정) |
| 유닛테스트 녹색, 실 DB 500 | H2 create-drop | Testcontainers validate 스모크 |
| 무관한 테스트 폭발 | 컨텍스트 캐시 LRU가 공유 H2 DROP | cache.maxSize 상향 |
| 통합테스트 녹색, 로컬 기동 실패 | Flyway 번호 역전 (clean 로드는 못 잡음) | 머지 직전 번호 재확인 |
| E2E 결제 401 | compose 백엔드 시크릿 빈 값 | e2e 프로필 백엔드 |
| 스크롤 복원 깨짐 | Playwright click의 자동 스크롤 | evaluate 클릭 + 클릭 전 scrollY 확인 |
| ErrorState 안 뜸 | claude-in-chrome에서 react-query paused | Playwright route로 판정 |
| 화면 결함 재현 | compose 이미지 낡음 | npm run dev로 재확인 |
| 터치 타깃 미달 | input만 측정 | closest('label')로 측정 |
| 서버 성능 나쁨 | bootRun의 C2 JIT 비활성 | java -jar로 측정 |
