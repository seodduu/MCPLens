# FAQ

이 문서는 설치를 마친 다음에야 나오는 질문에 답한다. CLI와 확장이 충돌하면 무슨 일이
일어나는지, 리포트가 예상보다 얇아 보이는 이유는 무엇인지, 대시보드는 지금 어떤 상태인지다.

## Can I run `mcp-lens scan` while the VS Code extension is open?

가능하다. 다만 둘 중 하나만 동시에 쓸 수 있다. 확장과 CLI의 `scan`·`auth` 명령은
`~/.mcplens/lens.db`에 저장하기 전에 같은 writer lease를 두고 경쟁한다. 확장이 이미 lease를
쥐고 있으면 CLI 명령은 실행을 거부하고 다음을 출력한다.

```
The VS Code extension is writing the MCP Lens DB, so this command cannot run right now.
Close the extension window (or the other running mcp-lens) and try again. It may also clear on its own shortly.
```

`mcp-lens report`는 거부당할 일이 없다. lease를 잡을 수 있으면 로그 백필 결과를 저장하고,
잡을 수 없으면 그 저장만 건너뛰고 읽기 전용으로 실행되며, 두 경우 모두 같은 리포트를 출력한다.
그래도 이 거부는 워크플로가 아니라 안전망으로만 취급한다. CLI와 확장을 같은 데이터베이스에
동시에 돌리는 것 자체를 피한다.

## Why does my report only cover the last 30 days by default?

`--days`의 기본값은 30이며, 원본 클라이언트 로그(Claude Code, Codex, Gemini CLI)가 스스로
만료되기 전까지 세션 기록을 보관하는 기간과 맞춘 것이다. Lens 데이터베이스는 한 번 수집한
관측치를 영구히 보관하므로, Lens를 30일 넘게 돌렸다면 더 큰 `--days` 값을 넘겨서 더 먼 과거를
볼 수 있다. 할 수 없는 것은 Lens를 설치하기 전 기간을 백필하는 것이다. 그 기간의 원본 로그는
이미 사라진 뒤이기 때문이다.

## Which clients support global actions?

Claude Code와 Codex뿐이다. 전역 조치는 클라이언트 자신의 설정 파일을 편집해서 쓰지 않는 MCP
툴을 끄는데, Gemini CLI는 그 편집의 대상이 아니다. Gemini CLI도 스캔, 훅 수집, 리포트는 전부
똑같이 받지만, 그것만은 자동으로 꺼지지 않는다. 롤아웃 설정이 클라이언트별로 이를 어떻게
제어하는지는 [Global Actions](/ko/guide/global-actions)를 본다.

## Is the local dashboard still maintained?

아니다, 동결됐다. 코드와 테스트는 동결 시점 기준으로 여전히 동작하고 `npm start -w
@mcp-lens/dashboard`로 지금도 실행할 수 있지만, VS Code 사이드바가 그 역할을 흡수했기 때문에
새 기능은 여기 들어가지 않는다. 간단히 훑어보는 것 이상은 확장의 사이드바를 쓴다. 지금도
남아 있는 기능은 [Dashboard](/ko/guide/dashboard)에서 확인한다.

## I installed hooks but my usage is always zero. What's wrong?

CLI 전용 경로를 쓰고 있다면 이는 설정 실수가 아니라 현재의 한계다. 훅은 호출마다
`~/.mcplens/inbox` 큐에 기록을 남기고, 그 큐를 `~/.mcplens/lens.db`로 비우는 것은 VS Code
확장뿐이다. `mcp-lens` CLI에는 큐를 비우는 경로가 아예 없어서, 확장이 한 번도 실행되지 않으면
그 기록은 큐에 남은 채 데이터베이스에 도달하지 못한다.

`mcp-lens hooks status`로 확인한다. `pending` 개수가 0으로 돌아가지 않고 계속 늘어난다면
바로 이 상황이며, `mcp-lens hooks doctor`도 같은 일에 대해 경고를 낸다.

```bash
mcp-lens hooks status
```

지켜봐야 할 줄은 `pending`이다 (필드 이름은 실제 그대로이고 숫자는 예시다).

```
  pending: 128
```

기다리는 동안 아무것도 유실되지 않는다. [VS Code extension](/ko/guide/vscode-extension)을
한 번 실행하면 큐 전체가 비워진다. 그 전까지 `mcp-lens report`가 보여줄 수 있는 유일한 사용량은
각 클라이언트 자신의 세션 로그를 파싱해서 복구한 값이며, 이는 inbox와는 다른 별개의 경로다.
두 경로 전체는 [How It Works](/ko/concepts/how-it-works)에서 다룬다.

이미 확장을 실행하고 있는데도 `calls` 열이 여전히 0이라면, 원인은 클라이언트마다 다르다.
특히 Codex는 훅 해시를 신뢰해 줘야 한다. 다음 질문을 본다.

## My Codex hooks are installed but no events show up. What's wrong?

Codex는 현재 훅 정의 해시를 신뢰하기 전까지 MCP Lens를 포함해 플러그인이 번들한 훅을
건너뛴다. `mcp-lens hooks doctor codex`로 확인한다.

```bash
mcp-lens hooks doctor codex
```

```
[WARNING] codex codex-trust-unapproved: Codex hook trust is not approved; review it with /hooks.
```

이 경고가 보이면 Codex 세션 안에서 `/hooks`를 열어 MCP Lens 훅 정의를 검토하고 현재 해시를
신뢰 처리한다. 훅 상태는 다음 세션부터 적용되므로 그 이후 새 Codex 세션을 시작한다. 플러그인이
업데이트되어 해시가 바뀔 때마다 이 과정을 다시 확인한다.

## Why did `npx mcp-lens` run something I didn't expect?

`mcp-lens`라는 이름으로 이미 npm에 게시된 무관한 패키지가 하나 있다. 로컬 bin이 없으면
`npx mcp-lens`는 이 서드파티 패키지를 그대로 내려받아 실행하며, 이는 이 프로젝트가 아니다.
MCP Lens 자체는 npm에 게시되어 있지 않다. 저장소에서 직접 빌드해서 워크스페이스 bin을 쓴다.
`npx --no-install mcp-lens`를 항상 써서 npx가 이미 로컬에 설치된 bin만 실행하도록 하거나,
링크된 bin을 직접 호출한다.

```bash
npm install && npm run build
npm link -w @mcp-lens/cli
mcp-lens --help
```
