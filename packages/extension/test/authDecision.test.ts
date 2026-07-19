import { describe, it, expect } from 'vitest';
import { decideAuthPrompt } from '../src/authDecision.js';
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
});
