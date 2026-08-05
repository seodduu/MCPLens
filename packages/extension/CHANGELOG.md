# Changelog

## 0.3.0

This release centres on two things. First, the dependency analysis that decides "is this tool safe
to turn off" and the global actions moved inside the extension. Second, an onboarding walkthrough
and a Setup Status view now tell you what to do right after installing.

### Added

- **Tool dependency analysis and the independence verdict.** `MCP Lens: Analyze Dependencies`
  analyzes the relationships between tools. It combines cross-references in the definition text,
  real call chains and, where needed, an LLM semantic verdict to decide which tools can be turned
  off without breaking others. `MCP Lens: Open Analysis Details` opens the basis of a verdict, and
  `MCP Lens: Reanalyze Server` reruns the analysis for one server.
- **Servers added later are handled automatically (with consent).** On the first run the extension
  neither scans nor analyzes on its own. The onboarding walkthrough has you start it yourself, and
  its last step asks once whether new servers should be measured and analyzed for you. You pick one
  of three: both scanning and analysis, scanning only, or neither. If you accept, a newly added MCP
  server is scanned without a notification and then only the not-yet-analyzed tools are analyzed,
  using the consent already on file **and the provider and model recorded in it**. A server that
  needs a login raises the login notification at that point. `mcpLens.autoScan` and
  `mcpLens.autoAnalyze` change it later.
- **Inference provider settings and up-front consent.** `mcpLens.inferenceProvider`
  (auto/claude/codex), `mcpLens.claudeModel` and `mcpLens.codexModel` pick the provider and model
  used for the analysis. Before running, it states what is transmitted and the expected cost and
  asks for consent; withdrawing it with `MCP Lens: Withdraw Inference Consent` also stops the
  automatic analysis. Only tool definitions and aggregated usage counts are transmitted: no prompts,
  tool inputs, tool outputs or source code.
- **Global disable and restore.** `MCP Lens: Disable Globally` / `MCP Lens: Restore Globally` turn
  unused tools off directly in the client config and put them back. It is locked by default: the
  `mcplens.dependencyAnalysis.rollout` setting must name which clients are allowed
  (off/claude/codex/all), and you are shown what will be lost before it runs. Gemini CLI is not a
  target of global actions.
- **Onboarding walkthrough.** The walkthrough opens on the first activation after installation. It
  guides you through four steps (scan, hook installation, dependency analysis, enabling global
  actions), and each step's checkmark turns on and off from the real state.
- **Setup Status view.** See the scan state and the per-client hook collection state in one place in
  the sidebar. The former Collection Status view was absorbed into it. Hook installation and removal
  run directly from the rows.
- **New commands.** `MCP Lens: Scan MCP Servers`, `MCP Lens: Install Hooks for All Clients`,
  `MCP Lens: Sign In to Server`, `MCP Lens: Open Global Actions Setting`.
- **The last scan state is stored per server,** recording which server succeeded or failed and when,
  so the views can explain the scan results as they are.

### Changed

- **User-facing strings are all English now,** cleaning up the mixture in command titles, setting
  descriptions and view names.
- **The matrix tree is sorted by cost,** putting the most expensive first, and the wording and hover
  descriptions that repeated the same thing on every row are gone.
- **Setup Status icons carry a status colour and the token unit is uniformly `tokens`.**
- The restore action, like the removal action, is visible directly on row hover.

### Fixed

- **Load attribution was wrong in Codex code mode.** Loaded definitions were attached to a server at
  the wrong moment, so usage went to the wrong server. It now happens at materialization time and
  already-collected data recovers retroactively. The N definitions in a substring search output are
  recorded as per-tool loads too.
- **Delivery lock debris kept piling up** on real devices. It is now cleared at takeover time and
  old debris is reclaimed.
- **The per-client server mapping update could be cut off midway.** `upsertClientServers` is now one
  transaction, so no partially applied state remains.
- **The server scan state was not recorded on the scan and login paths.**
- **The CLI died on non-Error exceptions.** Both the scan exception classification and the login
  failure handling normalize non-Error values now, and a failed login rescan no longer skips saving.
- **Merely importing a CLI module opened the real DB.**
- **A path that bypassed the tree refresh generation guard is closed.** A stale result arriving late
  could overwrite the newest screen.

## 0.2.0

Never released. Work after 0.1.1 was bundled into one release, so the version skipped to 0.3.0.

## 0.1.1

Centred on Windows support fixes. Collection was effectively broken on Windows in 0.1.0.

### Fixed

- **Client CLIs were not found on Windows.** claude-code did not appear in the collection state at
  all, and codex and gemini-cli stayed permanently "disconnected" even with hooks installed. Binary
  lookup was POSIX-only.
  - `PATHEXT` extensions (`.exe`/`.cmd`/`.bat`) are looked up. `.cmd` wins over the unrunnable
    extensionless script an npm global install ships alongside it.
  - Windows install locations are candidates now: `%USERPROFILE%\.local\bin` (Claude Code native),
    `%APPDATA%\npm`, `%LOCALAPPDATA%\Volta\bin`.
  - The nvm-windows layout (`<root>\<version>\<name>`) is recognized.
  - `.cmd`/`.bat` run through the shell. Node 18.20.2+ blocks a direct spawn with EINVAL.

- **Correlation mismatches piled up on every MCP call on Windows.** The hook envelope file name
  contained a colon, and `:` is a reserved file-name character on Windows. NTFS read it as an
  alternate data stream, so only the tool-call envelopes were selectively lost. The session hooks
  arrived fine, which made it look like "the hooks are alive but the correlation keeps failing".
  Names are now encoded safely at the file system boundary, and existing colon file names stay
  readable.

- **Gemini hook installation waited forever.** For a local-path install, gemini-cli 0.51.0 raises a
  folder trust prompt even with `--consent`, and there is no flag to skip it. The install button
  hung with no feedback while processes piled up. The bundle directory is now registered in the
  trust list before installing.

### Added

- **Automatic refresh of a stale hook runtime.** When the extension auto-updated, the already
  installed hook runtime stayed as it was, and a mismatch between the two broke collection with no
  warning. The runtime now carries a content fingerprint, and the hooks are reinstalled
  automatically at startup when it differs from the bundle.

### Internal

- Child process execution has a 120-second ceiling. If any CLI adds a new interactive prompt, the UI
  fails instead of waiting forever.

## 0.1.0

Initial release.
