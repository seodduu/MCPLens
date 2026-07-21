// bundle-smoke.mjs — load the bundled extension WITHOUT VS Code and drive
// activate() far enough to exercise the two risky runtime assets:
//   - core/store.ts reading schema.sql (import.meta.url shim)
//   - sql.js loading sql-wasm.wasm
// A minimal `vscode` module is injected via Module._load interception, since the
// bundle keeps `require('vscode')` external.
import { createRequire } from 'node:module';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'dist', 'extension.js');

// Point the shared DB path at a throwaway dir so we never touch ~/.mcplens/lens.db.
process.env.HOME = mkdtempSync(join(tmpdir(), 'mcplens-smoke-'));

// ---- minimal vscode stub (only the surface activate() touches) ----
const disposable = { dispose() {} };
const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItem: class {
    constructor(label, state) { this.label = label; this.collapsibleState = state; }
  },
  EventEmitter: class {
    constructor() { this.event = () => disposable; }
    fire() {}
    dispose() {}
  },
  Uri: { file: (p) => ({ fsPath: p, path: p }) },
  RelativePattern: class {
    constructor(base, pattern) { this.base = base; this.pattern = pattern; }
  },
  window: {
    createStatusBarItem: () => ({ text: '', command: '', show() {}, hide() {}, dispose() {} }),
    registerTreeDataProvider: () => disposable,
    showTextDocument: async () => ({}),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => disposable,
    createFileSystemWatcher: () => ({
      onDidChange: () => disposable,
      onDidCreate: () => disposable,
      onDidDelete: () => disposable,
      dispose() {},
    }),
    openTextDocument: async () => ({}),
  },
  commands: { registerCommand: () => disposable },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return realLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const ext = require(bundlePath);

if (typeof ext.activate !== 'function') {
  console.error('FAIL: activate is not a function');
  process.exit(1);
}

const ctx = { subscriptions: [] };
try {
  await ext.activate(ctx);
  // If we got here, schema.sql loaded (LensStore.open) and sql.js wasm resolved.
  console.log('SMOKE OK: activate() completed — schema.sql + sql-wasm.wasm resolved');
  if (typeof ext.deactivate === 'function') await ext.deactivate();
  process.exit(0);
} catch (err) {
  console.error('SMOKE FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
}
