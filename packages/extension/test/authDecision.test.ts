import { describe, it, expect } from 'vitest';
import { decideAuthPrompt, friendlyAuthError } from '../src/authDecision.js';
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
});

describe('friendlyAuthError', () => {
  it('DCR 403 Forbidden은 자동 등록 미허용 안내로 바꾼다', () => {
    const msg = friendlyAuthError(new Error(
      'HTTP 403: Invalid OAuth error response: ... Raw body: Forbidden'));
    expect(msg).toContain('자동 클라이언트 등록');
    expect(msg).toContain('headers');
  });

  it('dynamic client registration 문구도 같은 안내로 바꾼다', () => {
    const msg = friendlyAuthError(new Error('dynamic client registration not supported'));
    expect(msg).toContain('자동 클라이언트 등록');
  });

  it('그 외 에러는 원문 메시지를 그대로 담는다', () => {
    expect(friendlyAuthError(new Error('oauth callback timeout'))).toContain('timeout');
  });

  it('Error가 아니어도 문자열로 안전하게 처리한다', () => {
    expect(friendlyAuthError('boom')).toContain('boom');
  });
});
