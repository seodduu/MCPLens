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
 * 런타임 내용 지문. 확장은 이 값으로 "설치된 훅 런타임이 번들과 같은가"를 판정한다.
 *
 * 확장이 마켓플레이스에서 자동 업데이트돼도 이미 설치된 런타임 사본은 그대로
 * 남는다. 그 낡은 사본이 조용히 다른 형식을 만들어내면(실측: inbox 파일명)
 * 수집이 망가진 채로 원인 표시 없이 방치된다 — 그걸 감지하는 유일한 수단이다.
 * 버전 번호가 아니라 내용 해시인 이유: 런타임은 core에서 생성되므로 사람이
 * 올려야 하는 번호는 반드시 잊힌다.
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
    // inbox.js가 import하므로 반드시 함께 복사한다. core가 lease를 별도 모듈로
    // 분리했을 때 이 목록이 갱신되지 않아, 재동기화 시 런타임이 깨졌다.
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
