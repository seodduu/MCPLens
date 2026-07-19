import { describe, it, expect } from 'vitest';
import { readClaudeMcpConfig, specTransport } from '../../src/scanner/configs.js';

describe('readClaudeMcpConfig', () => {
  it('url만 있는 서버는 http spec으로 수집된다', () => {
    const json = JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.com' } } });
    expect(readClaudeMcpConfig(json)).toEqual([
      { name: 'remote', command: undefined, args: undefined, env: undefined,
        url: 'https://mcp.example.com' }]);
  });
  it('specTransport 판별', () => {
    expect(specTransport({ name: 'a', command: 'node', args: [] })).toBe('stdio');
    expect(specTransport({ name: 'b', url: 'https://x' })).toBe('http');
    expect(specTransport({ name: 'c' })).toBe('unknown');
  });
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
