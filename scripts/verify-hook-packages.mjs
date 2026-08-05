#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { canonicalRuntimeEntries } from '../packages/hook-runtime/scripts/sync-runtime.mjs';

const verifierPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(process.env.MCP_LENS_VERIFY_REPO_ROOT ?? resolve(dirname(verifierPath), '..'));
const runtimeFiles = [
  'package.json',
  'ingest/contracts.js',
  'ingest/identity.js',
  'ingest/lease.js',
  'ingest/inbox.js',
  'ingest/clients/claude/decoder.js',
  'ingest/clients/codex/decoder.js',
  'ingest/clients/gemini/decoder.js',
  'hook-capture.mjs',
  'runtime-stamp.json',
];
const runtimeTree = (() => {
  const entries = new Map();
  for (const relativePath of runtimeFiles) {
    const parts = relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      entries.set(parts.slice(0, index).join('/'), 'directory');
    }
    entries.set(relativePath, 'file');
  }
  return [...entries]
    .map(([path, type]) => ({ path, type }))
    .sort((left, right) => left.path.localeCompare(right.path));
})();
const allowedBuiltins = new Set(['node:crypto', 'node:fs', 'node:os', 'node:path']);
const processDeadlineMs = 2_000;

const clients = [
  {
    name: 'Claude',
    packageDir: 'packages/lens-audit-plugin',
    manifest: '.claude-plugin/plugin.json',
    hookFile: 'hooks/hooks.json',
    fixture: 'fixtures/hooks/claude/post-tool-use.json',
    runnerToken: '${CLAUDE_PLUGIN_ROOT}/scripts/hook-runner.mjs',
    runnerArgument: '',
  },
  {
    name: 'Codex',
    packageDir: 'packages/codex-plugin',
    manifest: '.codex-plugin/plugin.json',
    hookFile: 'hooks/hooks.json',
    fixture: 'fixtures/hooks/codex/post-tool-use.json',
    runnerToken: '${PLUGIN_ROOT}/scripts/hook-runner.mjs',
    runnerArgument: ' codex',
  },
  {
    name: 'Gemini',
    packageDir: 'packages/gemini-extension',
    manifest: 'gemini-extension.json',
    hookFile: 'hooks/hooks.json',
    fixture: 'fixtures/hooks/gemini/after-tool.json',
    runnerToken: '${extensionPath}/scripts/hook-runner.mjs',
    runnerArgument: '',
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function entriesBelow(root, relativePath = '') {
  return readdirSync(join(root, relativePath), { withFileTypes: true }).flatMap((entry) => {
    const child = join(relativePath, entry.name);
    const item = {
      path: child.split(sep).join('/'),
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    };
    return entry.isDirectory() ? [item, ...entriesBelow(root, child)] : [item];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function hookEntries(value, entries = []) {
  if (Array.isArray(value)) {
    for (const item of value) hookEntries(item, entries);
  } else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') entries.push(value);
    for (const item of Object.values(value)) hookEntries(item, entries);
  }
  return entries;
}

function sensitiveStrings(value, key = '', inheritedSensitive = false) {
  const isSensitive = inheritedSensitive
    || /tool_input|tool_response|llmContent|returnDisplay|prompt|error/i.test(key);
  if (Array.isArray(value)) {
    return value.flatMap((item) => sensitiveStrings(item, key, isSensitive));
  }
  if (!value || typeof value !== 'object') {
    return isSensitive && typeof value === 'string' ? [value] : [];
  }
  return Object.entries(value).flatMap(
    ([childKey, child]) => sensitiveStrings(child, childKey, isSensitive),
  );
}

function assertRuntimeBytes(packageRoot) {
  const first = canonicalRuntimeEntries();
  const second = canonicalRuntimeEntries();
  const runtimeRoot = join(packageRoot, 'runtime');
  assert.deepEqual([...first], [...second], 'canonical runtime generation is not deterministic');
  assert.deepEqual([...first.keys()], runtimeFiles);
  assert(
    lstatSync(runtimeRoot).isDirectory(),
    'runtime root must be a real directory owned inside the package',
  );
  assert.deepEqual(
    entriesBelow(runtimeRoot),
    runtimeTree,
    'runtime tree differs from exact allowlist',
  );
  assert.deepEqual(readJson(join(packageRoot, 'runtime/package.json')), { type: 'module' });
  for (const relativePath of runtimeFiles) {
    const reference = Buffer.from(first.get(relativePath), 'utf8');
    const candidate = readFileSync(join(packageRoot, 'runtime', relativePath));
    assert.deepEqual(candidate, reference, `${relativePath} differs from canonical runtime input`);
  }
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function assertAllowedModuleSource(source, sourcePath, packageRoot) {
  assert.doesNotMatch(
    source,
    /\bnpx\b|@mcp-lens\/core|node_modules|https?:\/\/|\blens\.db\b|\bLensStore\b|\bvscode\b|\bfetch\s*\(|\bWebSocket\b|\brequire\s*\(|\bimport\s*\(|\bnode:(?:child_process|cluster|dgram|dns|http|http2|https|net|sqlite|tls|worker_threads)\b|\b(?:better-sqlite3|sqlite3)\b/i,
    `forbidden runtime capability in ${sourcePath}`,
  );
  for (const specifier of moduleSpecifiers(source)) {
    if (specifier.startsWith('node:')) {
      assert(allowedBuiltins.has(specifier), `forbidden builtin import ${specifier} in ${sourcePath}`);
      continue;
    }
    assert(
      specifier.startsWith('./') || specifier.startsWith('../'),
      `forbidden external dependency ${specifier} in ${sourcePath}`,
    );
    const importedPath = resolve(dirname(sourcePath), specifier);
    assert(isWithin(packageRoot, importedPath), `import escapes package: ${specifier}`);
    const imported = lstatSync(importedPath);
    assert(imported.isFile(), `local import is not a regular file: ${specifier}`);
  }
}

function validateModuleSource(sourcePath, packageRoot) {
  assertAllowedModuleSource(readFileSync(sourcePath, 'utf8'), sourcePath, packageRoot);
}

function assertNoExternalRuntime(packageRoot) {
  const sourcePaths = [
    join(packageRoot, 'scripts', 'hook-runner.mjs'),
    ...runtimeFiles
      .filter((relativePath) => /\.(?:js|mjs)$/.test(relativePath))
      .map((relativePath) => join(packageRoot, 'runtime', relativePath)),
  ];
  for (const sourcePath of sourcePaths) validateModuleSource(sourcePath, packageRoot);
}

function assertHookCommand(command, client, packageRoot, runner) {
  const expected = `node "${client.runnerToken}"${client.runnerArgument}`;
  assert.equal(command, expected, `unexpected ${client.name} runner command`);
  const match = /^node "([^"\r\n]+)"(?: ([a-z]+))?$/.exec(command);
  assert(match, `invalid ${client.name} command structure`);
  assert.equal(match[1], client.runnerToken);
  assert.equal(match[2] ? ` ${match[2]}` : '', client.runnerArgument);
  const tokenRootEnd = client.runnerToken.indexOf('/');
  assert(tokenRootEnd > 0, `invalid ${client.name} runner token`);
  const referencedRunner = resolve(packageRoot, client.runnerToken.slice(tokenRootEnd + 1));
  assert.equal(realpathSync(referencedRunner), realpathSync(runner));
  assert(lstatSync(referencedRunner).isFile(), `${client.name} runner is not a regular file`);
}

function expectedPendingEntry(entries) {
  assert.equal(entries.length, 1, `unexpected pending artifacts: ${JSON.stringify(entries)}`);
  assert.equal(entries[0].type, 'file', 'pending artifact must be a regular file');
  // `~` is the file-name encoding of the `:` in a deliveryId (inbox.ts fileStem).
  // On Windows `:` is reserved and cannot appear in a file name as it is.
  assert.match(entries[0].path, /^[A-Za-z0-9][A-Za-z0-9._~-]*\.json$/);
  return entries[0];
}

/** Same encoding as fileStem in inbox.ts: `:` is a reserved file-name character on Windows. */
function fileStem(deliveryId) {
  return deliveryId.replaceAll(':', '~');
}

function assertPendingArtifacts(pendingRoot) {
  const entry = expectedPendingEntry(entriesBelow(pendingRoot));
  const pendingPath = join(pendingRoot, entry.path);
  const envelope = readJson(pendingPath);
  assert.equal(entry.path, `${fileStem(envelope.deliveryId)}.json`, 'pending filename must match deliveryId');
  return pendingPath;
}

function assertPendingEnvelopeCount(pendingRoot, expectedCount) {
  const entries = entriesBelow(pendingRoot);
  assert.equal(entries.length, expectedCount, `expected ${expectedCount} pending envelopes`);
  const envelopes = entries.map((entry) => {
    assert.equal(entry.type, 'file', 'pending artifact must be a regular file');
    const envelope = readJson(join(pendingRoot, entry.path));
    assert.equal(entry.path, `${fileStem(envelope.deliveryId)}.json`, 'pending filename must match deliveryId');
    return envelope;
  });
  assert.equal(new Set(envelopes.map((envelope) => envelope.deliveryId)).size, expectedCount);
  return envelopes;
}

function assertNoSensitiveFiles(inboxRoot, secrets) {
  for (const entry of entriesBelow(inboxRoot)) {
    if (entry.type !== 'file') continue;
    const contents = readFileSync(join(inboxRoot, entry.path), 'utf8');
    for (const secret of secrets) {
      assert(!contents.includes(secret), `persisted sensitive fixture value in ${entry.path}: ${secret}`);
    }
  }
}

function spawnRunner(runner, input, inboxRoot, extraEnv = {}) {
  return spawnSync(process.execPath, [runner], {
    input,
    encoding: 'utf8',
    timeout: processDeadlineMs,
    env: { ...process.env, ...extraEnv, MCP_LENS_INBOX_DIR: inboxRoot },
  });
}

function spawnWithHangingStdin(runner, inboxRoot) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [runner], {
      env: { ...process.env, MCP_LENS_INBOX_DIR: inboxRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const parentDeadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runner did not exit with held-open stdin within ${processDeadlineMs}ms`));
    }, processDeadlineMs);
    child.once('error', (error) => {
      clearTimeout(parentDeadline);
      reject(error);
    });
    child.once('exit', (status, signal) => {
      clearTimeout(parentDeadline);
      resolvePromise({ status, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.stdin.write('{');
  });
}

function assertSuccessfulResult(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '', 'successful hook capture must not write stderr');
}

function runVerifierMutationChecks() {
  const client = clients[0];

  function runMutation(name, mutate, expectedFailure) {
    const mutationRoot = mkdtempSync(join(tmpdir(), 'mcplens-verifier-mutation-'));
    try {
      mkdirSync(dirname(join(mutationRoot, client.packageDir)), { recursive: true });
      mkdirSync(dirname(join(mutationRoot, client.fixture)), { recursive: true });
      cpSync(join(repoRoot, client.packageDir), join(mutationRoot, client.packageDir), { recursive: true });
      cpSync(join(repoRoot, client.fixture), join(mutationRoot, client.fixture));
      mutate(mutationRoot);
      const result = spawnSync(process.execPath, [verifierPath], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          MCP_LENS_VERIFY_REPO_ROOT: mutationRoot,
          MCP_LENS_VERIFY_MUTATION_WORKER: '1',
          MCP_LENS_VERIFY_CLIENT: client.name,
        },
      });
      assert.equal(result.error, undefined, `${name}: verifier process failed to run`);
      assert.equal(result.signal, null, `${name}: verifier process was terminated`);
      assert.notEqual(result.status, 0, `${name}: verifier accepted mutation`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        expectedFailure,
        `${name}: verifier failed for the wrong reason`,
      );
    } finally {
      rmSync(mutationRoot, { recursive: true, force: true });
    }
  }

  runMutation('unexpected empty runtime directory', (mutationRoot) => {
    mkdirSync(join(mutationRoot, client.packageDir, 'runtime', 'unexpected-empty'));
  }, /runtime tree differs from exact allowlist/);

  runMutation('symlinked runtime root', (mutationRoot) => {
    const packageRuntime = join(mutationRoot, client.packageDir, 'runtime');
    const externalRuntime = join(mutationRoot, 'external-runtime');
    cpSync(packageRuntime, externalRuntime, { recursive: true });
    rmSync(packageRuntime, { recursive: true });
    try {
      symlinkSync(
        externalRuntime,
        packageRuntime,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      throw new Error(
        `symlinked runtime root: unable to create required directory symlink: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, /runtime root must be a real directory/);

  runMutation('runner command path deviation', (mutationRoot) => {
    const hookPath = join(mutationRoot, client.packageDir, client.hookFile);
    const hooks = readJson(hookPath);
    hookEntries(hooks)[0].command = `node "${client.runnerToken}.missing"`;
    writeFileSync(hookPath, `${JSON.stringify(hooks, null, 2)}\n`);
  }, /unexpected Claude runner command/);

  runMutation('forbidden process import', (mutationRoot) => {
    appendFileSync(
      join(mutationRoot, client.packageDir, 'scripts', 'hook-runner.mjs'),
      "\nimport 'node:child_process';\n",
    );
  }, /forbidden runtime capability/);

  runMutation('unexpected pending artifact', (mutationRoot) => {
    appendFileSync(
      join(mutationRoot, client.packageDir, 'scripts', 'hook-runner.mjs'),
      [
        '',
        "import { mkdirSync as mutationMkdir, writeFileSync as mutationWrite } from 'node:fs';",
        "import { join as mutationJoin } from 'node:path';",
        "const mutationPending = mutationJoin(process.env.MCP_LENS_INBOX_DIR, 'pending');",
        'mutationMkdir(mutationPending, { recursive: true });',
        "mutationWrite(mutationJoin(mutationPending, 'unexpected.tmp'), 'stale');",
        '',
      ].join('\n'),
    );
  }, /unexpected pending artifacts/);

  runMutation('copied runtime byte mismatch', (mutationRoot) => {
    appendFileSync(
      join(mutationRoot, client.packageDir, 'runtime', 'ingest', 'contracts.js'),
      '\n',
    );
  }, /ingest\/contracts\.js differs from canonical runtime input/);
}

async function verifyClient(client) {
  const packageRoot = join(repoRoot, client.packageDir);
  const manifest = readJson(join(packageRoot, client.manifest));
  assert.equal(manifest.name, 'mcp-lens');

  const hooks = readJson(join(packageRoot, client.hookFile));
  const entries = hookEntries(hooks);
  assert(entries.length > 0, 'hook manifest has no commands');
  const runner = join(packageRoot, 'scripts', 'hook-runner.mjs');
  for (const entry of entries) assertHookCommand(entry.command, client, packageRoot, runner);

  assertRuntimeBytes(packageRoot);
  assertNoExternalRuntime(packageRoot);

  const inboxRoot = mkdtempSync(join(tmpdir(), `mcplens-${client.name.toLowerCase()}-`));
  try {
    const fixtureText = readFileSync(join(repoRoot, client.fixture), 'utf8');
    const fixture = JSON.parse(fixtureText);
    const result = spawnRunner(runner, fixtureText, inboxRoot, {
      NODE_OPTIONS: '--no-experimental-detect-module',
    });
    assertSuccessfulResult(result);

    const pendingRoot = join(inboxRoot, 'pending');
    assertPendingArtifacts(pendingRoot);
    assertNoSensitiveFiles(inboxRoot, sensitiveStrings(fixture));

    if (client.name === 'Gemini') {
      const repeatedFixture = {
        ...fixture,
        timestamp: '2026-07-20T01:24:46.678Z',
      };
      const repeated = spawnRunner(runner, JSON.stringify(repeatedFixture), inboxRoot);
      assertSuccessfulResult(repeated);
      assertPendingEnvelopeCount(pendingRoot, 2);
      assertNoSensitiveFiles(inboxRoot, sensitiveStrings(repeatedFixture));
    }
    const beforeMalformed = entriesBelow(inboxRoot);

    const malformed = spawnRunner(runner, '{malformed', inboxRoot);
    assert.equal(malformed.error, undefined);
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(malformed.signal, null);
    assert.equal(malformed.stdout, '{}\n');
    assert.match(malformed.stderr, /^mcp-lens hook ignored invalid payload: /);
    assert.deepEqual(entriesBelow(inboxRoot), beforeMalformed);

    const hanging = await spawnWithHangingStdin(runner, inboxRoot);
    assert.equal(hanging.status, 0, hanging.stderr);
    assert.equal(hanging.signal, null);
    assert.equal(hanging.stdout, '{}\n');
    assert.match(hanging.stderr, /^mcp-lens hook capture failed: hook stdin timed out/);
    assert(hanging.elapsedMs < processDeadlineMs, `held-open stdin exit took ${hanging.elapsedMs}ms`);
    assert.deepEqual(entriesBelow(inboxRoot), beforeMalformed);
  } finally {
    rmSync(inboxRoot, { recursive: true, force: true });
  }
}

if (process.env.MCP_LENS_VERIFY_MUTATION_WORKER !== '1') runVerifierMutationChecks();
let failures = 0;
const requestedClient = process.env.MCP_LENS_VERIFY_CLIENT;
const selectedClients = requestedClient
  ? clients.filter((client) => client.name === requestedClient)
  : clients;
assert(selectedClients.length > 0, `unknown verifier client: ${requestedClient}`);
for (const client of selectedClients) {
  try {
    await verifyClient(client);
    console.log(`${client.name}: PASS`);
  } catch (error) {
    failures += 1;
    console.error(`${client.name}: FAIL`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failures > 0) process.exitCode = 1;
