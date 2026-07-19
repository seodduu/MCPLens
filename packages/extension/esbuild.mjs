// esbuild.mjs — single-file CJS bundle for the VS Code extension.
//
// Why a bundle: `@mcp-lens/core` is an npm-workspace package, hoisted/symlinked
// into the root node_modules. `vsce package` cannot follow that symlink into a
// .vsix, so we inline everything into one CJS file (external: ['vscode'] only).
//
// Two runtime assets survive as separate files and are copied next to the bundle:
//   1. core/store.ts reads `schema.sql` via `dirname(fileURLToPath(import.meta.url))`.
//      In a CJS bundle `import.meta.url` is undefined, so we shim it to the bundle's
//      own file URL (banner + define). dirname(bundle) === dist, so schema.sql must
//      live in dist/.
//   2. sql.js loads `sql-wasm.wasm` at runtime relative to its scriptDirectory,
//      which in a Node CJS bundle resolves from __dirname (== dist). Copy the wasm
//      into dist/ so its default lookup finds it.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outdir = join(here, 'dist');
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(here, 'src/extension.ts')],
  outfile: join(outdir, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // vscode is provided by the host. fsevents is an optional native addon that
  // chokidar require()s inside a try/catch; excluding it lets chokidar fall back
  // to fs.watch (native .node addons cannot be bundled).
  external: ['vscode', 'fsevents'],
  sourcemap: false,
  minify: false,
  // Shim import.meta.url for the CJS output so core/store.ts can resolve schema.sql.
  banner: {
    js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: { 'import.meta.url': '__import_meta_url' },
  logLevel: 'info',
});

// Copy runtime assets next to the bundle.
const schemaSrc = require.resolve('@mcp-lens/core/dist/store/schema.sql');
copyFileSync(schemaSrc, join(outdir, 'schema.sql'));

const wasmSrc = require.resolve('sql.js/dist/sql-wasm.wasm');
copyFileSync(wasmSrc, join(outdir, 'sql-wasm.wasm'));

console.log('[esbuild] bundled dist/extension.js + schema.sql + sql-wasm.wasm');
