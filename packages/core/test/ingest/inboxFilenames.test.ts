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
 * 훅 러너는 툴 이벤트의 deliveryId를 `native:<hash>` 형태로 만든다(identity.ts).
 * 그 문자열을 그대로 파일명에 쓰면 Windows에서 깨진다 — `:` 는 파일명 예약
 * 문자이고 NTFS에서는 대체 데이터 스트림 문법으로 해석돼, `pending\native:x.json`
 * 이 `native` 라는 빈 파일의 숨은 스트림이 된다. 목록에는 `native` 만 보이고
 * `.json` 으로 끝나지 않으므로 claimPending이 영원히 건너뛴다 = 툴 호출 훅 유실.
 */
const WINDOWS_RESERVED = /[<>:"/\\|?*]/;

describe('inbox 파일명 — Windows 예약 문자', () => {
  it('deliveryId에 콜론이 있어도 파일명에는 예약 문자가 없다', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });

    const names = readdirSync(join(root, 'pending'));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toMatch(WINDOWS_RESERVED);
  });

  it('잠금·커밋 보조 파일에도 예약 문자가 없다', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });

    for (const name of readdirSync(join(root, '.locks'))) {
      expect(name).not.toMatch(WINDOWS_RESERVED);
    }
  });

  it('인코딩해도 원래 deliveryId 그대로 claim된다 (왕복 보존)', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });

    const claims = claimPending({ root });
    expect(claims.map((c) => c.deliveryId)).toEqual(['native:770a4bef']);
    expect(claims[0].envelope.deliveryId).toBe('native:770a4bef');
  });

  it('claim 후 markProcessed까지 예약 문자 없이 완주한다', () => {
    const root = temporaryRoot();
    enqueueEnvelope(envelope({ deliveryId: 'native:770a4bef' }), { root });
    const [claim] = claimPending({ root });

    markProcessed(claim, { root });

    const processed = readdirSync(join(root, 'processed'));
    expect(processed).toHaveLength(1);
    expect(processed[0]).not.toMatch(WINDOWS_RESERVED);
    expect(readdirSync(join(root, 'pending'))).toEqual([]);
  });

  it('중복 enqueue는 여전히 duplicate로 걸러진다', () => {
    const root = temporaryRoot();
    expect(enqueueEnvelope(envelope({ deliveryId: 'native:dup' }), { root })).toBe('queued');
    expect(enqueueEnvelope(envelope({ deliveryId: 'native:dup' }), { root })).toBe('duplicate');
  });

  // macOS/Linux에 이미 쌓여 있는 콜론 파일명은 업그레이드 후에도 읽혀야 한다.
  it('구버전이 남긴 콜론 파일명도 그대로 claim된다', () => {
    const root = temporaryRoot();
    const paths = inboxPaths({ root });
    const legacy = envelope({ deliveryId: 'native:legacy' });
    writeFileSync(join(paths.pending, 'native:legacy.json'), JSON.stringify(legacy));

    const claims = claimPending({ root });
    expect(claims.map((c) => c.deliveryId)).toEqual(['native:legacy']);
  });
});
