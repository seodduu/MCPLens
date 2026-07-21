import { describe, it, expect } from 'vitest';
import { decideAuthPrompt, friendlyAuthError, isDcrRejected } from '../src/authDecision.js';
import type { McpServerSpec } from '@mcp-lens/core';

const spec = (name: string): McpServerSpec => ({ name, url: `https://${name}.example/mcp` });

describe('decideAuthPrompt', () => {
  it('실패한 서버가 없으면 skip', () => {
    expect(decideAuthPrompt({ failedServers: [], ignoreList: [] }))
      .toEqual({ kind: 'skip' });
  });

  it('실패한 서버가 전부 ignoreList에 있으면 skip', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('linear')],
      ignoreList: ['vercel', 'linear'],
    });
    expect(d).toEqual({ kind: 'skip' });
  });

  it('일부만 ignoreList에 있으면 나머지만 prompt', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('linear')],
      ignoreList: ['linear'],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel')] });
  });

  it('신규 실패 서버(ignore 없음)는 전부 prompt', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('linear')],
      ignoreList: [],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel'), spec('linear')] });
  });

  it('세션 스누즈된 서버는 prompt에서 제외된다 (나중에 → 재시작까지 억제)', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('figma')],
      ignoreList: [],
      sessionSnoozed: ['figma'],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel')] });
  });

  it('전부 세션 스누즈되면 skip', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('figma')],
      ignoreList: [],
      sessionSnoozed: ['figma'],
    });
    expect(d).toEqual({ kind: 'skip' });
  });

  it('지원하지 않는(unsupported) 서버는 다시는 prompt하지 않는다', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('figma')],
      ignoreList: [],
      unsupported: ['figma'],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel')] });
  });
});

describe('isDcrRejected', () => {
  it('403 Forbidden(DCR 거부)이면 true', () => {
    expect(isDcrRejected(new Error(
      'HTTP 403: Invalid OAuth error response: ... Raw body: Forbidden'))).toBe(true);
  });

  it('dynamic client registration 실패 문구도 true', () => {
    expect(isDcrRejected(new Error('dynamic client registration not supported'))).toBe(true);
  });

  it('그 외 에러(timeout 등)는 false', () => {
    expect(isDcrRejected(new Error('oauth callback timeout'))).toBe(false);
  });

  it('Error가 아니어도 안전하게 판정한다', () => {
    expect(isDcrRejected('boom')).toBe(false);
  });
});

describe('friendlyAuthError', () => {
  it('DCR 외 에러는 원문 메시지를 그대로 담는다', () => {
    expect(friendlyAuthError(new Error('oauth callback timeout'))).toContain('timeout');
  });

  it('Error가 아니어도 문자열로 안전하게 처리한다', () => {
    expect(friendlyAuthError('boom')).toContain('boom');
  });
});
