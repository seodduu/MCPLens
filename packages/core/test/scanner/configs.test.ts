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

describe('headers 패스스루 (PAT 방식 http 서버)', () => {
  it('http 서버의 headers가 spec에 실린다', () => {
    const json = JSON.stringify({ mcpServers: {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/',
                headers: { Authorization: 'Bearer ghp_test123' } } } });
    const specs = readClaudeMcpConfig(json);
    expect(specs[0].headers).toEqual({ Authorization: 'Bearer ghp_test123' });
  });
  it('headers가 없으면 undefined', () => {
    const json = JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://a' } } });
    expect(readClaudeMcpConfig(json)[0].headers).toBeUndefined();
  });
});
