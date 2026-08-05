import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookEnvelope } from '../../src/ingest/contracts.js';
import { claimPending, enqueueEnvelope, inboxPaths, markProcessed } from '../../src/ingest/inbox.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-inbox-names-'));
  roots.push(root);
  return root;
}

function envelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    schemaVersion: 1,
    deliveryId: 'd1',
    client: 'claude-code',
    phase: 'tool-after',
    receivedAt: '2026-07-20T00:00:01.000Z',
    externalSessionId: 'session-1',
    externalTurnId: null,
    externalCallId: 'call-1',
    transcriptPath: null,
    serverName: 'lenstest',
    toolName: 'get_weather',
    observedAt: '2026-07-20T00:00:00.000Z',
    durationMs: 12,
    isError: false,
    inputFingerprint: 'sha256:abc',
    ...overrides,
  };
}

/**
 * The hook runner builds the deliveryId of a tool event as `native:<hash>` (identity.ts).
 * Using that string as a file name breaks on Windows: `:` is a reserved file-name character and
 * NTFS reads it as alternate-data-stream syntax, so `pending\native:x.json` becomes a hidden
 * stream of an empty file called `native`. The listing shows only `native`, which does not end in
 * `.json`, so claimPending skips it forever and the tool-call hook is lost.
 */
const WINDOWS_RESERVED = /[<>:"/\\|?*]/;

describe('inbox file names and Windows reserved characters', () => {
  it('keeps reserved characters out of the file name even when the deliveryId has a colon', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });

    const names = readdirSync(join(root, 'pending'));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toMatch(WINDOWS_RESERVED);
  });

  it('keeps reserved characters out of the lock and commit helper files too', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });

    for (const name of readdirSync(join(root, '.locks'))) {
      expect(name).not.toMatch(WINDOWS_RESERVED);
    }
  });

  it('claims the original deliveryId back after encoding (round trip preserved)', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });

    const claims = claimPending({ root });
    expect(claims.map((c) => c.deliveryId)).toEqual(['native:770a4bef']);
    expect(claims[0].envelope.deliveryId).toBe('native:770a4bef');
  });

  it('runs from claim through markProcessed with no reserved character', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });
    const [claim] = claimPending({ root });

    markProcessed(claim, { root });

    const processed = readdirSync(join(root, 'processed'));
    expect(processed).toHaveLength(1);
    expect(processed[0]).not.toMatch(WINDOWS_RESERVED);
    expect(readdirSync(join(root, 'pending'))).toEqual([]);
  });

  it('still filters a duplicate enqueue as duplicate', () => {
    const root = temporaryRoot();
    expect(enqueueEnvelope(envelope({ deliveryId: 'native:dup' }), { root })).toBe('queued');
    expect(enqueueEnvelope(envelope({ deliveryId: 'native:dup' }), { root })).toBe('duplicate');
  });

  it('does not requeue the same envelope when an old colon file remains in pending', () => {
    const root = temporaryRoot();
    const paths = inboxPaths({ root });
    const legacy = envelope({ deliveryId: 'native:legacy' });
    writeFileSync(join(paths.pending, 'native:legacy.json'), JSON.stringify(legacy));

    expect(enqueueEnvelope(legacy, { root })).toBe('duplicate');
    expect(readdirSync(paths.pending)).toEqual(['native:legacy.json']);
  });

  it('claims an old colon file and runs it through to markProcessed', () => {
    const root = temporaryRoot();
    const paths = inboxPaths({ root });
    const legacy = envelope({ deliveryId: 'native:legacy' });
    writeFileSync(join(paths.pending, 'native:legacy.json'), JSON.stringify(legacy));

    const [claim] = claimPending({ root });
    markProcessed(claim, { root });

    expect(readdirSync(paths.pending)).toEqual([]);
    expect(readdirSync(join(root, 'processed'))).toHaveLength(1);
  });

  // Colon file names already piled up on macOS/Linux must stay readable after an upgrade.
  it('claims a colon file name left by an older version as it is', () => {
    const root = temporaryRoot();
    const paths = inboxPaths({ root });
    const legacy = envelope({ deliveryId: 'native:legacy' });
    writeFileSync(join(paths.pending, 'native:legacy.json'), JSON.stringify(legacy));

    const claims = claimPending({ root });
    expect(claims.map((c) => c.deliveryId)).toEqual(['native:legacy']);
  });
});
