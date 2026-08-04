# 프론트 함정 (TypeScript / vitest / Playwright / 브라우저 검증)

## 타입체크는 `-p` 없이는 0파일 검사다

루트 `tsconfig.json`이 프로젝트 레퍼런스 구조(`"files": []` + `references`)면
`npx tsc --noEmit`은 **0개 파일을 검사하고 성공**한다. 거짓 녹색이 실제 타입 에러 7건을
가린 전례가 있다. 타입체크 DoD·계획서·서브에이전트 지시에는 항상
`npx tsc --noEmit -p tsconfig.app.json`을 명시한다.

## vitest가 Playwright 스펙을 집어삼킨다

vitest 설정에 `exclude: ['e2e/**']`가 없으면 `npx vitest run`이 Playwright 전용 스펙까지
수집해 항상 1 failed로 끝난다(거짓 적신호). 서브에이전트 여러 명이 각자 이걸 "기존 이슈"로
재확인하는 비용을 낸다. **새 프로젝트에서는 처음부터 vitest 설정에 e2e 제외를 넣어라.**
그 전까지는 전체 판정 기준을 `npm test`(exclude 걸린 스크립트)로 통일한다.

## Playwright `locator.click()`은 클릭 전에 스크롤한다

스크롤 위치가 걸린 동작(뒤로가기 복원 등)을 검증할 때 `locator.click()`을 쓰면 Playwright가
먼저 요소를 뷰포트로 끌어올린다. "떠날 때 위치"가 바뀐 뒤라 앱이 정상인데도 복원이 깨진
것처럼 보인다. 이 착시로 정상 코드를 세 번 고쳐 넣었다가 전부 폐기한 전례가 있다.
스크롤이 관여하는 시나리오는 화면에 이미 보이는 요소를 `page.evaluate(() => el.click())`로
누르고, "복원 실패"를 진단하기 전에 클릭 직전 scrollY를 먼저 찍는다.

## 터치 타깃은 `closest('label')`로 잰다

`input[type=radio]` 요소만 재면 13×13 미달로 나오지만, label이 감싸는 마크업이면 실제 탭
영역은 라벨 카드 전체다. 측정 스크립트는 요소마다 `el.closest('label') || el`의 사각형을
재고, 같은 label 중복은 `Set`으로 거른다. input만 재고 "44px 미달" 결함을 보고했다가
오탐으로 판명된 전례가 있다.

## claude-in-chrome에서는 react-query 에러 상태가 안 나온다

claude-in-chrome이 붙은 Chrome에서 API를 실패시키면 쿼리가 `fetchStatus=paused`에 갇혀
끝내 error로 안 넘어간다. ErrorState가 절대 렌더되지 않아 "유닛테스트 녹색인데 실화면이
안 고쳐진다"로 보이고, 멀쩡한 코드를 더 건드리게 만든다.

- 에러 화면 판정은 Playwright 임시 스펙으로:
  `page.route('**/api/...', r => r.fulfill({status:500}))` + `page.screenshot` (끝나면 스펙 삭제).
- claude-in-chrome으로 보다가 이상하면 queryClient의 `fetchStatus`를 먼저 읽어 `paused`인지
  확인한다. paused면 앱이 아니라 도구 문제다.
- 성공 경로(정상 렌더·토스트)는 claude-in-chrome으로 충분하다. 단 `form_input`은 React
  state를 갱신하지 않으므로 클릭 후 `type`으로 입력한다.

## compose 프론트 이미지는 낡는다

`docker compose`로 떠 있는 프론트는 빌드 시점에 얼어붙은 이미지다. 머지 후 재빌드하지
않으면 옛 프론트가 새 백엔드 응답 형태와 어긋나 **소스에는 없는 결함**을 보여준다
(배열 → 페이지 응답 전환 후 `n.map is not a function` 크래시 등).
화면을 눈으로 확인하는 작업은 `npm run dev`(vite, API 프록시)로 한다. 소스가 곧 화면이다.
compose 화면에서 이상한 것을 보면 `docker image inspect --format '{{.Created}}'`와 최근
머지 커밋 시각을 대조하고, 어긋나면 `docker compose up -d --build` 후 다시 판단한다.

## 이미지 에셋 수급

- Gemini 무료 등급은 이미지 생성 API를 못 쓴다(키가 유효해도 429, 쿼터 사실상 0).
- Pexels는 무료 키 즉시 발급, 표기 의무 없음, 상업 사용 가능. 실용적 대안.
- 검색어는 용기·배경을 명시해야 제품컷이 나온다(`shaving foam can`,
  `makeup pencil white background`). 사진가당 상한을 걸면 같은 촬영분 쏠림이 줄어든다.
- 이미지 풀 크기는 "정렬 축으로 몰렸을 때 한 화면에 같은 사진이 몇 번 보이는지"로 정한다.
  카테고리당 3~5장 + `id % n` 배정은 카테고리 정렬 목록에서 같은 사진이 3번씩 떠서 실패했다.
