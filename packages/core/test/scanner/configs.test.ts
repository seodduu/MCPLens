import { describe, it, expect } from 'vitest';
import { readClaudeMcpConfig } from '../../src/scanner/configs.js';

describe('readClaudeMcpConfig', () => {
  it('mcpServers 표준 포맷에서 spec 목록을 뽑는다', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    expect(readClaudeMcpConfig(json)).toEqual([
      { name: 'github', command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'], env: undefined },
    ]);
  });
  it('mcpServers가 없으면 빈 배열', () => {
    expect(readClaudeMcpConfig('{}')).toEqual([]);
  });
  it('깨진 JSON이면 빈 배열 (throw 금지)', () => {
    expect(readClaudeMcpConfig('{oops')).toEqual([]);
  });
});
