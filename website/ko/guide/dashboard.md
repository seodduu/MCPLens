# 대시보드

이 문서를 끝내면 로컬 웹 대시보드를 빌드하고 실행하는 방법과 거기서 무엇을 기대할 수 있는지
알게 된다. **대시보드는 동결됐다.** 코드와 테스트는 저장소에 남아 있지만 새 기능은 더 이상
여기 들어가지 않는다. VS Code 사이드바(`Cost × Usage Matrix`와 `Setup Status` 뷰)가 그
역할을 흡수했기 때문이다. 동결 시점 기준으로는 여전히 동작한다.

## VS Code 사이드바 대신 언제 쓰는가

이미 [VS Code 확장](/ko/guide/vscode-extension)을 쓰고 있다면 사이드바가 유지보수되는
경로이고 같은 비용 × 사용량 매트릭스를 다룬다. 대시보드는 VS Code를 열지 않고 브라우저로만
보고 싶을 때, 예를 들어 CLI 전용 경로로 작업할 때만 쓴다.

## 빌드와 실행

```bash
npm run build -w @mcp-lens/dashboard
npm start -w @mcp-lens/dashboard
```

start 명령은 자신이 리스닝 중인 주소를 출력한다.

```
MCP Lens dashboard: http://127.0.0.1:43117
```

브라우저에서 `http://127.0.0.1:43117`을 연다. 대시보드는 `mcp-lens scan`과 훅이 쓰는 것과
같은 `~/.mcplens/lens.db`를 읽으므로, 이미 수집된 데이터가 있으면 그걸 보여준다. 아직 스캔을
돌리지 않았다면 [빠른 시작](/ko/quick-start)을 보고, 매트릭스의 열이 무엇을 뜻하는지는
[리포트 읽기](/ko/guide/reading-reports)를 본다.

## 알려진 한계

한 번에 하나의 writer만 데이터베이스를 쥘 수 있다. CLI는 `~/.mcplens/lens.db`에 쓰기 전에
writer lease를 가져가므로, 두 번째 writer(예를 들어 lease를 쥔 VS Code 확장)는 조용히 덮어
쓰이는 대신 깔끔하게 거부당한다. 그래도 CLI와 확장을 같은 데이터베이스에 동시에 돌리는 것은
피한다. 대시보드는 이 데이터베이스를 그대로 읽으므로, `scan`이 거부되면 실제로 스캔이
성공할 때까지 대시보드는 이전 데이터를 계속 보여준다. 정확한 거부 메시지는
[FAQ](/ko/faq)에서 확인한다.
