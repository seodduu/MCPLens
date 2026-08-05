#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageRoots = [
  'packages/lens-audit-plugin',
  'packages/codex-plugin',
  'packages/gemini-extension',
];

const compiledRoot = join(repoRoot, 'packages/core/dist');
const canonicalCapture = join(repoRoot, 'packages/hook-runtime/hook-capture.mjs');

function compiled(relative) {
  return readFileSync(join(compiledRoot, relative), 'utf8');
}

function replaceRequired(source, pattern, replacement, label) {
  const result = source.replace(pattern, replacement);
  if (result === source) throw new Error(`canonical runtime transform not found: ${label}`);
  return result;
}

function standaloneInbox() {
  let source = compiled('ingest/inbox.js');
  source = replaceRequired(
    source,
    "import { join } from 'node:path';",
    "import { join } from 'node:path';\nimport { homedir } from 'node:os';",
    'inbox homedir import',
  );
  source = replaceRequired(source, "import { inboxPath } from '../paths.js';\n", '', 'inbox core paths import');
  return replaceRequired(
    source,
    'const root = opts.root ?? inboxPath();',
    "const root = opts.root ?? join(homedir(), '.mcplens', 'inbox');",
    'inbox default root',
  );
}

function standaloneGeminiDecoder() {
  const source = compiled('ingest/clients/gemini/decoder.js');
  const helper = `const splitFlattenedName = (name) => {\n    const match = /^mcp_(.+)$/.exec(name);\n    if (!match) return null;\n    const rest = match[1];\n    const separator = rest.indexOf('_');\n    if (separator === -1) return { server: rest, tool: rest };\n    return { server: rest.slice(0, separator), tool: rest.slice(separator + 1) };\n};\n`;
  return replaceRequired(
    source,
    "import { splitFlattenedName } from '../../../adapters/gemini/adapter.js';\n",
    helper,
    'Gemini adapter import',
  );
}

/**
 * Content fingerprint of the runtime. The extension uses it to decide whether the installed hook
 * runtime matches the bundle.
 *
 * Even when the extension auto-updates from the marketplace, an already-installed runtime copy
 * stays as it is. If that stale copy silently produces a different format (measured: the inbox file
 * names), collection stays broken with nothing to indicate why. This is the only way to detect it.
 * Why a content hash rather than a version number: the runtime is generated from core, so a number
 * a human has to bump will inevitably be forgotten.
 */
function runtimeStamp(entries) {
  const hash = createHash('sha256');
  for (const [relative, content] of entries) {
    hash.update(relative);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function canonicalRuntimeEntries() {
  const entries = baseRuntimeEntries();
  const stamp = runtimeStamp(entries);
  return new Map([
    ...entries,
    ['runtime-stamp.json', `${JSON.stringify({ stamp }, null, 2)}\n`],
  ]);
}

function baseRuntimeEntries() {
  return new Map([
    ['package.json', '{\n  "type": "module"\n}\n'],
    ['ingest/contracts.js', compiled('ingest/contracts.js')],
    ['ingest/identity.js', compiled('ingest/identity.js')],
    // inbox.js imports it, so it must always be copied along. When core split lease into its own
    // module, this list was not updated and the resynced runtime broke.
    ['ingest/lease.js', compiled('ingest/lease.js')],
    ['ingest/inbox.js', standaloneInbox()],
    ['ingest/clients/claude/decoder.js', compiled('ingest/clients/claude/decoder.js')],
    ['ingest/clients/codex/decoder.js', compiled('ingest/clients/codex/decoder.js')],
    ['ingest/clients/gemini/decoder.js', standaloneGeminiDecoder()],
    ['hook-capture.mjs', readFileSync(canonicalCapture, 'utf8')],
  ]);
}

export function syncRuntime() {
  const entries = canonicalRuntimeEntries();
  for (const packageRelative of packageRoots) {
    const runtimeRoot = join(repoRoot, packageRelative, 'runtime');
    rmSync(runtimeRoot, { recursive: true, force: true });
    for (const [relative, content] of entries) {
      const destination = join(runtimeRoot, relative);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      writeFileSync(destination, content, { encoding: 'utf8', mode: 0o644 });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncRuntime();
}
