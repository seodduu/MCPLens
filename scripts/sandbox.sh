#!/usr/bin/env bash
# MCP Lens 격리 샌드박스 — 로컬 개인 데이터 없이 확장을 실사용처럼 테스트한다.
#
#   ./scripts/sandbox.sh            # 마켓플레이스판(seodduu.mcp-context-lens) 설치 후 실행
#   ./scripts/sandbox.sh --no-install  # 확장 미설치 — 마켓플레이스에서 직접 설치해볼 때
#   ./scripts/sandbox.sh --vsix p   # 로컬 VSIX 설치 후 실행
#   ./scripts/sandbox.sh --reset    # 샌드박스 전체 삭제 후 재생성
#   SANDBOX=~/other ./scripts/sandbox.sh
#
# 격리 원리: Node의 os.homedir()는 $HOME을 그대로 따르므로, VS Code를
# HOME=<샌드박스>/home 으로 띄우면 확장이 보는 ~/.mcplens, ~/.claude,
# ~/.codex, ~/.gemini 가 전부 샌드박스 안이다. 실 홈은 읽지도 쓰지도 않는다.
set -euo pipefail

SANDBOX="${SANDBOX:-$HOME/mcplens-sandbox}"
EXT_ID="seodduu.mcp-context-lens"
VSIX=""
INSTALL=1
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 실행 바이너리 이름은 VS Code 버전에 따라 다르다. 요즘 빌드는 Code이고 예전 빌드는
# Electron이었다. 낡은 이름을 박아 두면 env가 "No such file or directory"로 죽는다.
CODE_MACOS="/Applications/Visual Studio Code.app/Contents/MacOS"
if [ -n "${CODE_APP:-}" ]; then
  :
elif [ -x "$CODE_MACOS/Code" ]; then
  CODE_APP="$CODE_MACOS/Code"
elif [ -x "$CODE_MACOS/Electron" ]; then
  CODE_APP="$CODE_MACOS/Electron"
else
  echo "VS Code 실행 바이너리를 찾지 못했습니다: $CODE_MACOS" >&2
  echo "다른 위치에 설치했다면 CODE_APP=<바이너리 경로> $0 로 지정하세요." >&2
  exit 2
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --vsix) VSIX="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --reset) rm -rf "$SANDBOX"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

FAKE_HOME="$SANDBOX/home"
USER_DATA="$SANDBOX/vscode-user-data"
EXT_DIR="$SANDBOX/vscode-extensions"
WORKSPACE="$SANDBOX/workspace"

# Electron IPC 소켓 경로가 103자를 넘으면 창이 뜨지 않는다 — 짧은 경로만 허용.
if [ ${#USER_DATA} -gt 60 ]; then
  echo "SANDBOX 경로가 너무 깁니다(${#USER_DATA}자). 더 짧은 경로를 쓰세요: SANDBOX=/tmp/mlsb $0" >&2
  exit 2
fi

mkdir -p "$FAKE_HOME" "$USER_DATA/User" "$EXT_DIR" "$WORKSPACE" \
         "$FAKE_HOME/.claude/projects" "$FAKE_HOME/.codex/sessions" "$FAKE_HOME/.gemini/tmp"
# 로그 루트는 clientLogRoots()와 정확히 일치해야 한다(packages/core/src/paths.ts):
# claude-code=.claude/projects, codex=.codex/sessions, gemini-cli=.gemini/tmp.
# 부모 디렉터리(.codex, .gemini)만 만들면 detectClients()가 미설치로 걸러
# 매트릭스·수집 상태에서 해당 클라이언트가 통째로 사라진다.

# 워크스페이스 신뢰 프롬프트를 끄지 않으면 확장이 활성화되지 않은 채 대기한다.
if [ ! -f "$USER_DATA/User/settings.json" ]; then
  cat > "$USER_DATA/User/settings.json" <<'EOF'
{
  "security.workspace.trust.enabled": false,
  "window.title": "MCP LENS SANDBOX — ${activeEditorShort}"
}
EOF
fi

# ── 샌드박스 홈 시드 ────────────────────────────────────────────────
# 데모 MCP 서버(툴 12개, 토큰만 먹고 대부분 안 쓰이는 시연용)를 Claude Code에 등록.
# 실 계정/키는 일절 넣지 않는다.
if [ ! -f "$FAKE_HOME/.claude.json" ]; then
  cat > "$FAKE_HOME/.claude.json" <<EOF
{
  "mcpServers": {
    "lenstest": { "command": "node", "args": ["$REPO/demo/lenstest-server.mjs"] }
  },
  "projects": {}
}
EOF
fi

# 3사 대칭 시드. claude만 등록하면 codex·gemini 경로는 호출할 서버가 0개라
# 애초에 검증이 불가능한 샌드박스가 된다 — 세 클라이언트에 같은 데모 서버를 건다.
# 기존 파일은 파괴하지 않는다(로그인 자격증명·훅 설치 흔적 보존): 없으면 만들고,
# 있으면 mcpServers 항목만 병합한다.
if [ ! -f "$FAKE_HOME/.gemini/settings.json" ]; then
  cat > "$FAKE_HOME/.gemini/settings.json" <<EOF
{
  "mcpServers": {
    "lenstest": { "command": "node", "args": ["$REPO/demo/lenstest-server.mjs"] }
  }
}
EOF
else
  SETTINGS="$FAKE_HOME/.gemini/settings.json" SERVER="$REPO/demo/lenstest-server.mjs" \
  node -e '
    const fs = require("fs");
    const p = process.env.SETTINGS;
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    s.mcpServers ??= {};
    s.mcpServers.lenstest ??= { command: "node", args: [process.env.SERVER] };
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  '
fi

# codex는 TOML — 이미 [mcp_servers.lenstest] 가 있으면 건드리지 않는다.
if ! grep -q '^\[mcp_servers\.lenstest\]' "$FAKE_HOME/.codex/config.toml" 2>/dev/null; then
  cat >> "$FAKE_HOME/.codex/config.toml" <<EOF

[mcp_servers.lenstest]
command = "node"
args = ["$REPO/demo/lenstest-server.mjs"]
EOF
fi

[ -f "$WORKSPACE/README.md" ] || echo "# MCP Lens sandbox" > "$WORKSPACE/README.md"

# ── 확장 설치 ───────────────────────────────────────────────────────
code_cli() {
  HOME="$FAKE_HOME" code --user-data-dir "$USER_DATA" --extensions-dir "$EXT_DIR" "$@"
}
if [ "$INSTALL" = 1 ]; then
  if [ -n "$VSIX" ]; then
    code_cli --install-extension "$VSIX" --force
  else
    code_cli --install-extension "$EXT_ID" --force
  fi
  code_cli --list-extensions --show-versions
else
  echo "확장 미설치 — 창의 Extensions에서 '$EXT_ID'를 직접 설치하세요."
fi

echo
echo "샌드박스: $SANDBOX"

# ── 실행 ────────────────────────────────────────────────────────────
# `code` 래퍼 대신 Electron 바이너리를 직접 띄워야 HOME 오버라이드가
# 확실히 확장 호스트까지 전달된다.
exec env HOME="$FAKE_HOME" "$CODE_APP" \
  --user-data-dir "$USER_DATA" \
  --extensions-dir "$EXT_DIR" \
  --new-window "$WORKSPACE"
