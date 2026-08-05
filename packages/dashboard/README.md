# @mcp-lens/dashboard: frozen (2026-07-20)

This surface is **frozen**. It is not deleted: the code and tests remain, and the full build and
test run must keep passing. What stops is new feature work (the confidence axis, per-client views,
the mode-aware filter and so on).

## Why it is frozen

- At design time (design doc ch. 6) it was "the always-on human interface", but the **VS Code
  sidebar tree (the extension) added later absorbed that role**. The target users are inside the
  editor, and the status bar and sidebar provide the always-on view right where they are.
- Maintenance cost, demonstrated: while core evolution (confidence, per-client, display filter) was
  applied to three surfaces, only the dashboard kept falling behind, and it produced a defect that
  exists solely because it is a separate process (the M8 reload race).

## Where its unique feature goes

- **Session timeline** (DevTools style): the one unique value of this surface. When it is needed,
  porting it into the extension as a VS Code **webview panel** matches the product direction
  (see the backlog).

## Usage (working as of the freeze)

```bash
npm start -w @mcp-lens/dashboard   # http://127.0.0.1:43117
```

API: `/api/matrix?days=N` · `/api/sessions?days=N` · `/api/timeline/:sessionId`
