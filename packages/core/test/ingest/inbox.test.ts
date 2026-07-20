import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookEnvelope } from '../../src/ingest/contracts.js';
import {
  claimPending,
  enqueueEnvelope,
  inboxPaths,
  markProcessed,
  releaseClaim,
} from '../../src/ingest/inbox.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-inbox-'));
  roots.push(root);
  return root;
}

function fixtureEnvelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    schemaVersion: 1,
    deliveryId: 'd1',
    client: 'codex',
    phase: 'tool-after',
    receivedAt: '2026-07-20T00:00:01.000Z',
    externalSessionId: 'session-1',
    externalTurnId: 'turn-1',
    externalCallId: 'call-1',
    transcriptPath: null,
    serverName: 'github',
    toolName: 'get_issue',
    observedAt: '2026-07-20T00:00:00.000Z',
    durationMs: 12,
    isError: false,
    inputFingerprint: 'sha256:abc',
    ...overrides,
  };
}

function runChild(helper: string, args: string[]): Promise<string> {
  const viteNode = join(process.cwd(), 'node_modules', '.bin', 'vite-node');
  return new Promise((resolve, reject) => {
    const child = spawn(viteNode, ['--script', helper, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child enqueue failed (${code}): ${stderr}`));
    });
  });
}

async function waitForFiles(root: string, prefix: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (readdirSync(root).filter((name) => name.startsWith(prefix)).length < count) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${count} ${prefix} files`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable hook inbox', () => {
  it('atomically enqueues one redacted event per delivery id', () => {
    const root = temporaryRoot();
    const env = { ...fixtureEnvelope(), secret: 'secret', tool_input: { token: 'secret' } } as HookEnvelope;

    expect(enqueueEnvelope(env, { root })).toBe('queued');
    expect(enqueueEnvelope(env, { root })).toBe('duplicate');

    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
    const persisted = readFileSync(join(root, 'pending', 'd1.json'), 'utf8');
    expect(persisted).not.toContain('secret');
    expect(Object.keys(JSON.parse(persisted))).toEqual(Object.keys(fixtureEnvelope()));
  });

  it('keeps one complete file when 20 independent processes enqueue the same delivery id', async () => {
    const root = temporaryRoot();
    const helper = join(root, 'enqueue-child.ts');
    const inboxSource = fileURLToPath(new URL('../../src/ingest/inbox.ts', import.meta.url));
    writeFileSync(helper, [
      `import { enqueueEnvelope } from ${JSON.stringify(inboxSource)};`,
      'const env = JSON.parse(process.argv[3]);',
      'process.stdout.write(enqueueEnvelope(env, { root: process.argv[2] }));',
    ].join('\n'));
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => runChild(helper, [root, JSON.stringify(fixtureEnvelope())])),
    );

    expect(outcomes.filter((result) => result === 'queued')).toHaveLength(1);
    expect(outcomes.filter((result) => result === 'duplicate')).toHaveLength(19);
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
    expect(JSON.parse(readFileSync(join(root, 'pending', 'd1.json'), 'utf8'))).toEqual(fixtureEnvelope());
  });

  it('publishes only a completed committed file through a no-replace hardlink', async () => {
    const root = temporaryRoot();
    const finalPath = join(root, 'pending', 'd1.json');
    let observedCommit = false;
    let observedPublish = false;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        renameSync(from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) {
          if (String(to).includes('.commit-')) {
            expect(actual.existsSync(finalPath)).toBe(false);
            expect(JSON.parse(actual.readFileSync(from, 'utf8'))).toEqual(fixtureEnvelope());
            observedCommit = true;
          }
          return actual.renameSync(from, to);
        },
        linkSync(from: Parameters<typeof actual.linkSync>[0], to: Parameters<typeof actual.linkSync>[1]) {
          if (String(to) === finalPath) {
            expect(observedCommit).toBe(true);
            expect(actual.existsSync(finalPath)).toBe(false);
            expect(JSON.parse(actual.readFileSync(from, 'utf8'))).toEqual(fixtureEnvelope());
            observedPublish = true;
          }
          return actual.linkSync(from, to);
        },
      };
    });
    const isolated = await import('../../src/ingest/inbox.js?atomic-publication');

    isolated.enqueueEnvelope(fixtureEnvelope(), { root });
    vi.doUnmock('node:fs');

    expect(observedCommit).toBe(true);
    expect(observedPublish).toBe(true);
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
  });

  it('prevents a late expired owner from publishing beside a newer processed event', async () => {
    const root = temporaryRoot();
    const env = fixtureEnvelope();
    let injected = false;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        linkSync(from: Parameters<typeof actual.linkSync>[0], to: Parameters<typeof actual.linkSync>[1]) {
          if (!injected && String(to).endsWith('d1.committed')) {
            injected = true;
            expect(enqueueEnvelope(env, { root, now: () => new Date('2026-07-21T00:00:10Z') })).toBe('queued');
            const [claim] = claimPending({ root, now: () => new Date('2026-07-21T00:00:11Z') });
            markProcessed(claim!, { root, now: () => new Date('2026-07-21T00:00:12Z') });
          }
          return actual.linkSync(from, to);
        },
      };
    });
    const isolated = await import('../../src/ingest/inbox.js?late-owner-publication');

    const result = isolated.enqueueEnvelope(env, {
      root,
      now: () => new Date('2026-07-21T00:00:00Z'),
    });
    vi.doUnmock('node:fs');

    expect(result).toBe('duplicate');
    expect(readdirSync(join(root, 'pending'))).toEqual([]);
    expect(readdirSync(join(root, 'processed'))).toEqual(['d1.json']);
  });

  it('ignores partial temporary files while claiming pending events', () => {
    const root = temporaryRoot();
    const { pending } = inboxPaths({ root });
    writeFileSync(join(pending, '.d1.partial.tmp'), '{"schemaVersion":1');

    expect(claimPending({ root })).toEqual([]);
    expect(readdirSync(pending)).toEqual(['.d1.partial.tmp']);
  });

  it('skips malformed event files, counts parse errors, and continues the batch', () => {
    const root = temporaryRoot();
    const { pending } = inboxPaths({ root });
    writeFileSync(join(pending, 'bad.json'), '{"schemaVersion":1', { mode: 0o600 });
    enqueueEnvelope(fixtureEnvelope(), { root });

    const claims = claimPending({ root });

    expect(claims.map((claim) => claim.deliveryId)).toEqual(['d1']);
    expect(claims.parseErrors).toBe(1);
    expect(readdirSync(pending)).toEqual(['d1.processing']);
    expect(readdirSync(join(root, 'processed'))).toEqual([]);
  });

  it('rejects valid JSON that is not the exact HookEnvelope contract', () => {
    const root = temporaryRoot();
    const { pending } = inboxPaths({ root });
    const valid = fixtureEnvelope({ deliveryId: 'valid' });
    const missing = { ...fixtureEnvelope({ deliveryId: 'missing' }) } as Record<string, unknown>;
    delete missing.client;
    const wrong = { ...fixtureEnvelope({ deliveryId: 'wrong' }), durationMs: '12' };
    const extra = { ...fixtureEnvelope({ deliveryId: 'extra' }), tool_input: { secret: true } };
    const mismatch = fixtureEnvelope({ deliveryId: 'payload-id' });
    for (const [name, value] of Object.entries({ missing, wrong, extra, 'filename-id': mismatch })) {
      writeFileSync(join(pending, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
    }
    writeFileSync(join(pending, 'valid.json'), JSON.stringify(valid), { mode: 0o600 });

    const claims = claimPending({ root });

    expect(claims.map((claim) => claim.deliveryId)).toEqual(['valid']);
    expect(claims.parseErrors).toBe(4);
    expect(readdirSync(pending)).toEqual(['valid.processing']);
  });

  it('claims by renaming to processing and can release the claim', () => {
    const root = temporaryRoot();
    enqueueEnvelope(fixtureEnvelope(), { root });

    const [claim] = claimPending({ root });

    expect(claim?.envelope).toEqual(fixtureEnvelope());
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.processing']);
    releaseClaim(claim!, { root });
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
  });

  it('treats processing and processed delivery ids as duplicates', () => {
    const root = temporaryRoot();
    enqueueEnvelope(fixtureEnvelope(), { root });
    const [claim] = claimPending({ root });

    expect(enqueueEnvelope(fixtureEnvelope(), { root })).toBe('duplicate');
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.processing']);

    markProcessed(claim!, { root });
    expect(enqueueEnvelope(fixtureEnvelope(), { root })).toBe('duplicate');
    expect(readdirSync(join(root, 'processed'))).toEqual(['d1.json']);
    expect(readdirSync(join(root, 'pending'))).toEqual([]);
  });

  it('serializes enqueue against a reverse processing-to-pending transition', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(fixtureEnvelope(), { root });
    claimPending({ root });
    const helper = join(root, 'reverse-transition-child.ts');
    const inboxSource = fileURLToPath(new URL('../../src/ingest/inbox.ts', import.meta.url));
    writeFileSync(helper, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      `import { enqueueEnvelope, releaseClaim } from ${JSON.stringify(inboxSource)};`,
      'const root = process.argv[2]; const mode = process.argv[3]; const env = JSON.parse(process.argv[4]);',
      "writeFileSync(`${root}/ready-${process.pid}`, '');",
      "while (!existsSync(`${root}/start`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
      "if (mode === 'release') { releaseClaim({ deliveryId: env.deliveryId, envelope: env }, { root }); process.stdout.write('released'); }",
      "else process.stdout.write(enqueueEnvelope(env, { root }));",
    ].join('\n'));
    const release = runChild(helper, [root, 'release', JSON.stringify(fixtureEnvelope())]);
    const enqueue = runChild(helper, [root, 'enqueue', JSON.stringify(fixtureEnvelope())]);
    await waitForFiles(root, 'ready-', 2);
    writeFileSync(join(root, 'start'), '');

    expect((await Promise.all([release, enqueue])).sort()).toEqual(['duplicate', 'released']);
    expect(readdirSync(join(root, 'pending'))).toEqual(['d1.json']);
  });

  it('recovers an expired lease even when its recorded pid is currently live', () => {
    const root = temporaryRoot();
    const { pending, locks } = inboxPaths({ root });
    const lock = join(locks, 'd1.lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      token: 'stale-owner', expiresAt: 0, pid: process.pid,
    }));

    expect(enqueueEnvelope(fixtureEnvelope(), {
      root,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    })).toBe('queued');
    expect(readdirSync(pending)).toEqual(['d1.json']);
  });

  it('honors an unexpired hard lease without relying on process liveness', () => {
    const root = temporaryRoot();
    const { pending, locks } = inboxPaths({ root });
    const lock = join(locks, 'd1.lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      token: 'live-owner',
      expiresAt: new Date('2026-07-20T01:00:01.000Z').getTime(),
    }));

    expect(enqueueEnvelope(fixtureEnvelope(), {
      root,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    })).toBe('duplicate');
    expect(readdirSync(pending)).toEqual([]);
    expect(readdirSync(locks)).toEqual(['d1.lock']);
  });

  it('allows exactly one synchronized process to take over an expired lock', async () => {
    const root = temporaryRoot();
    const { pending, locks } = inboxPaths({ root });
    const lock = join(locks, 'd1.lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'expired', expiresAt: 0 }));
    const helper = join(root, 'takeover-child.ts');
    const inboxSource = fileURLToPath(new URL('../../src/ingest/inbox.ts', import.meta.url));
    writeFileSync(helper, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      `import { enqueueEnvelope } from ${JSON.stringify(inboxSource)};`,
      'const root = process.argv[2]; const env = JSON.parse(process.argv[3]);',
      "writeFileSync(`${root}/ready-${process.pid}`, '');",
      "while (!existsSync(`${root}/start`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
      'process.stdout.write(enqueueEnvelope(env, { root }));',
    ].join('\n'));
    const results = Array.from({ length: 12 }, () => runChild(helper, [root, JSON.stringify(fixtureEnvelope())]));
    await waitForFiles(root, 'ready-', 12);
    writeFileSync(join(root, 'start'), '');

    const outcomes = await Promise.all(results);
    expect(outcomes.filter((value) => value === 'queued')).toHaveLength(1);
    expect(outcomes.filter((value) => value === 'duplicate')).toHaveLength(11);
    expect(readdirSync(pending)).toEqual(['d1.json']);
  });

  it('retains a terminal T tombstone so stale T observation cannot reap replacement U', async () => {
    const root = temporaryRoot();
    const { pending, locks } = inboxPaths({ root });
    let spoofStaleT = false;
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      return { ...actual, randomUUID: () => 'token-T' };
    });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) {
          if (spoofStaleT && String(path) === join(locks, 'd1.lock', 'owner.json')) {
            return JSON.stringify({ token: 'token-T', expiresAt: 0 });
          }
          return actual.readFileSync(path, options as never);
        },
      };
    });
    const isolated = await import('../../src/ingest/inbox.js?terminal-tombstone');
    expect(isolated.enqueueEnvelope(fixtureEnvelope(), { root })).toBe('queued');
    rmSync(join(pending, 'd1.json'));
    const replacement = join(locks, 'd1.lock');
    mkdirSync(replacement, { mode: 0o700 });
    writeFileSync(join(replacement, 'owner.json'), JSON.stringify({ token: 'token-U', expiresAt: Date.now() + 60_000 }));
    spoofStaleT = true;

    expect(isolated.enqueueEnvelope(fixtureEnvelope(), { root })).toBe('duplicate');
    vi.doUnmock('node:fs');
    vi.doUnmock('node:crypto');
    expect(JSON.parse(readFileSync(join(replacement, 'owner.json'), 'utf8')).token).toBe('token-U');
  });

  it('derives distinct takeover identities for successive missing-owner lock instances', () => {
    const root = temporaryRoot();
    const { pending, locks } = inboxPaths({ root });
    const lock = join(locks, 'd1.lock');
    mkdirSync(lock, { mode: 0o700 });
    expect(enqueueEnvelope(fixtureEnvelope(), { root })).toBe('queued');
    rmSync(join(pending, 'd1.json'));
    rmSync(join(locks, 'd1.committed'));
    mkdirSync(lock, { mode: 0o700 });

    expect(enqueueEnvelope(fixtureEnvelope(), { root })).toBe('queued');
    expect(readdirSync(pending)).toEqual(['d1.json']);
  });

  it('makes mark and release lock timeouts explicitly retryable', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(fixtureEnvelope(), { root });
    const [claim] = claimPending({ root });
    const { locks } = inboxPaths({ root });
    const lock = join(locks, 'd1.lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'busy', expiresAt: Date.now() + 60_000 }));
    const inbox = await import('../../src/ingest/inbox.js');

    expect(() => releaseClaim(claim!, { root, now: () => new Date() }))
      .toThrow(inbox.InboxLockBusyError);
    expect(() => markProcessed(claim!, { root, now: () => new Date() }))
      .toThrow(inbox.InboxLockBusyError);
  });

  it('recovers stale processing files before claiming them', () => {
    const root = temporaryRoot();
    const now = new Date('2026-07-20T01:00:00.000Z');
    enqueueEnvelope(fixtureEnvelope(), { root });
    const pending = join(root, 'pending');
    const processing = join(pending, 'd1.processing');
    renameSync(join(pending, 'd1.json'), processing);
    const stale = new Date('2026-07-20T00:00:00.000Z');
    utimesSync(processing, stale, stale);

    const claims = claimPending({ root, now: () => now });

    expect(claims.map((claim) => claim.deliveryId)).toEqual(['d1']);
    expect(readdirSync(pending)).toEqual(['d1.processing']);
  });

  it('tolerates independent stale-recovery races without duplicating claims', async () => {
    const root = temporaryRoot();
    enqueueEnvelope(fixtureEnvelope(), { root });
    const pending = join(root, 'pending');
    const processing = join(pending, 'd1.processing');
    renameSync(join(pending, 'd1.json'), processing);
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(processing, stale, stale);
    const helper = join(root, 'claim-child.ts');
    const inboxSource = fileURLToPath(new URL('../../src/ingest/inbox.ts', import.meta.url));
    writeFileSync(helper, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      `import { claimPending } from ${JSON.stringify(inboxSource)};`,
      'const root = process.argv[2];',
      "writeFileSync(`${root}/ready-${process.pid}`, '');",
      "while (!existsSync(`${root}/start`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
      'process.stdout.write(String(claimPending({ root }).length));',
    ].join('\n'));
    const results = Array.from({ length: 8 }, () => runChild(helper, [root]));
    await waitForFiles(root, 'ready-', 8);
    writeFileSync(join(root, 'start'), '');

    expect((await Promise.all(results)).reduce((sum, value) => sum + Number(value), 0)).toBe(1);
    expect(readdirSync(pending)).toEqual(['d1.processing']);
  });

  it('renews an old pending lease before publishing the processing claim', () => {
    const root = temporaryRoot();
    const now = new Date('2026-07-20T01:00:00.000Z');
    enqueueEnvelope(fixtureEnvelope(), { root });
    const pendingFile = join(root, 'pending', 'd1.json');
    const stale = new Date('2026-07-20T00:00:00.000Z');
    utimesSync(pendingFile, stale, stale);

    claimPending({ root, now: () => now });

    expect(statSync(join(root, 'pending', 'd1.processing')).mtimeMs).toBe(now.getTime());
    const source = readFileSync(new URL('../../src/ingest/inbox.ts', import.meta.url), 'utf8');
    const renew = source.indexOf('utimesSync(pendingPath, now, now)');
    const publish = source.indexOf('renameSync(pendingPath, processingPath)');
    expect(renew).toBeGreaterThanOrEqual(0);
    expect(renew).toBeLessThan(publish);
  });

  it('moves a completed claim to processed retention', () => {
    const root = temporaryRoot();
    enqueueEnvelope(fixtureEnvelope(), { root });
    const [claim] = claimPending({ root });

    markProcessed(claim!, { root });

    expect(readdirSync(join(root, 'pending'))).toEqual([]);
    expect(readdirSync(join(root, 'processed'))).toEqual(['d1.json']);
    expect(JSON.parse(readFileSync(join(root, 'processed', 'd1.json'), 'utf8'))).toEqual(fixtureEnvelope());
  });

  it('rejects serialized envelopes over 1 MiB without publishing a file', () => {
    const root = temporaryRoot();
    const oversized = fixtureEnvelope({ externalSessionId: 'x'.repeat(1024 * 1024) });

    expect(() => enqueueEnvelope(oversized, { root })).toThrow(/1 MiB/);
    expect(readdirSync(join(root, 'pending'))).toEqual([]);
  });

  it('enforces 0700 directories and exact 0600 event files under a restrictive open umask', async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'pending'), { mode: 0o755 });
    mkdirSync(join(root, 'processed'), { mode: 0o755 });
    chmodSync(root, 0o755);

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        openSync(path: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: number) {
          if (!String(path).endsWith('.tmp')) return actual.openSync(path, flags, mode);
          const previousUmask = process.umask(0o777);
          try {
            return actual.openSync(path, flags, mode);
          } finally {
            process.umask(previousUmask);
          }
        },
      };
    });
    const isolated = await import('../../src/ingest/inbox.js?restrictive-open-umask');

    isolated.enqueueEnvelope(fixtureEnvelope(), { root });
    vi.doUnmock('node:fs');

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'pending')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'processed')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, '.locks')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'pending', 'd1.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.locks', 'd1.committed')).mode & 0o777).toBe(0o600);
  });
});
