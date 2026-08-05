#!/usr/bin/env bash
# MCP Lens isolated sandbox: test the extension like real use, with no local personal data.
#
#   ./scripts/sandbox.sh            # install the marketplace build (seodduu.mcp-context-lens), then run
#   ./scripts/sandbox.sh --no-install  # no extension installed, for installing from the marketplace by hand
#   ./scripts/sandbox.sh --vsix p   # install a local VSIX, then run
#   ./scripts/sandbox.sh --reset    # delete the whole sandbox and recreate it
#   SANDBOX=~/other ./scripts/sandbox.sh
#
# How the isolation works: Node's os.homedir() follows $HOME exactly, so launching VS Code with
# HOME=<sandbox>/home puts the ~/.mcplens, ~/.claude, ~/.codex and ~/.gemini the extension sees
# entirely inside the sandbox. The real home is neither read nor written.
set -euo pipefail

SANDBOX="${SANDBOX:-$HOME/mcplens-sandbox}"
EXT_ID="seodduu.mcp-context-lens"
VSIX=""
INSTALL=1
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The executable name differs by VS Code version: recent builds use Code, older ones used Electron.
# Hardcoding the old name makes env die with "No such file or directory".
CODE_MACOS="/Applications/Visual Studio Code.app/Contents/MacOS"
if [ -n "${CODE_APP:-}" ]; then
  :
elif [ -x "$CODE_MACOS/Code" ]; then
  CODE_APP="$CODE_MACOS/Code"
elif [ -x "$CODE_MACOS/Electron" ]; then
  CODE_APP="$CODE_MACOS/Electron"
else
  echo "VS Code executable not found: $CODE_MACOS" >&2
  echo "If it is installed elsewhere, pass CODE_APP=<binary path> $0." >&2
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

# The window never appears if the Electron IPC socket path exceeds 103 characters, so only short paths are allowed.
if [ ${#USER_DATA} -gt 60 ]; then
  echo "The SANDBOX path is too long (${#USER_DATA} characters). Use a shorter one: SANDBOX=/tmp/mlsb $0" >&2
  exit 2
fi

mkdir -p "$FAKE_HOME" "$USER_DATA/User" "$EXT_DIR" "$WORKSPACE" \
         "$FAKE_HOME/.claude/projects" "$FAKE_HOME/.codex/sessions" "$FAKE_HOME/.gemini/tmp"
# The log roots must match clientLogRoots() exactly (packages/core/src/paths.ts):
# claude-code=.claude/projects, codex=.codex/sessions, gemini-cli=.gemini/tmp.
# Creating only the parent directories (.codex, .gemini) makes detectClients() filter them out as
# not installed, and that client disappears entirely from the matrix and the collection state.

# Without disabling the workspace trust prompt, the extension waits without ever activating.
if [ ! -f "$USER_DATA/User/settings.json" ]; then
  cat > "$USER_DATA/User/settings.json" <<'EOF'
{
  "security.workspace.trust.enabled": false,
  "window.title": "MCP LENS SANDBOX — ${activeEditorShort}"
}
EOF
fi

# -- Seed the sandbox home ------------------------------------------
# Register the demo MCP server (12 tools, mostly unused, eating tokens for the demo) with Claude Code.
# No real account or key is ever put in.
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

# Symmetric seeding across all three. Registering only claude leaves the codex and gemini paths with
# zero servers to call, making the sandbox unverifiable, so the same demo server goes to all three.
# Existing files are never destroyed (preserving login credentials and hook installation traces):
# create when absent, merge only the mcpServers entries when present.
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

# codex uses TOML, so leave it alone when [mcp_servers.lenstest] already exists.
if ! grep -q '^\[mcp_servers\.lenstest\]' "$FAKE_HOME/.codex/config.toml" 2>/dev/null; then
  cat >> "$FAKE_HOME/.codex/config.toml" <<EOF

[mcp_servers.lenstest]
command = "node"
args = ["$REPO/demo/lenstest-server.mjs"]
EOF
fi

[ -f "$WORKSPACE/README.md" ] || echo "# MCP Lens sandbox" > "$WORKSPACE/README.md"

# -- Install the extension ------------------------------------------
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
  echo "Extension not installed. Install '$EXT_ID' yourself from Extensions in the window."
fi

echo
echo "sandbox: $SANDBOX"

# -- Run ------------------------------------------------------------
# The Electron binary must be launched directly rather than through the `code` wrapper so the HOME
# override definitely reaches the extension host.
exec env HOME="$FAKE_HOME" "$CODE_APP" \
  --user-data-dir "$USER_DATA" \
  --extensions-dir "$EXT_DIR" \
  --new-window "$WORKSPACE"
