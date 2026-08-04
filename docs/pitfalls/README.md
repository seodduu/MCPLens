# 함정 모음 (참고 문서)

출처는 `github.com/seodduu/MyClaude`의 `pitfalls/`다. 다른 프로젝트(Spring Boot + Vite/React)에서
실제로 밟은 함정 기록이라 스택이 다른 항목도 섞여 있다. 원문을 그대로 보존하고, MCP Lens에
해당하는 항목만 `CLAUDE.md`·`AGENTS.md`의 "알려진 함정" 절에 발췌해 뒀다.

| 파일 | 내용 | MCP Lens 적용도 |
|---|---|---|
| `workflow.md` | worktree·병렬 웨이브·검증 운용, 거짓 신호 목록 | 대부분 그대로 유효 |
| `frontend-react.md` | TypeScript·vitest·Playwright·브라우저 검증 | tsc `-p` 누락, vitest 오수집, 화면 스크린샷 검증은 그대로 유효 |
| `backend-spring.md` | Spring/JPA/Flyway/Testcontainers | 스택이 다르다. "마이그레이션 번호 역전", "테스트 녹색이 실 DB를 보증하지 않는다"의 **원리만** 가져와 SQLite 스키마와 Wave 4 스모크에 적용 |

같은 증상을 실제로 만나면 그때 원문을 다시 본다. 새로 밟은 함정은 이 디렉토리에 항목을 추가하고,
판정에 쓰이는 것이면 `CLAUDE.md`·`AGENTS.md` 양쪽의 "알려진 함정" 절을 함께 갱신한다.
