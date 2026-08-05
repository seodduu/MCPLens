import { describe, it, expect } from 'vitest';
import { readClaudeMcpConfig, specTransport } from '../../src/scanner/configs.js';

describe('readClaudeMcpConfig', () => {
  it('collects a server with only a url as an http spec', () => {
    const json = JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.com' } } });
    expect(readClaudeMcpConfig(json)).toEqual([
      { name: 'remote', command: undefined, args: undefined, env: undefined,
        url: 'https://mcp.example.com' }]);
  });
  it('determines specTransport', () => {
    expect(specTransport({ name: 'a', command: 'node', args: [] })).toBe('stdio');
    expect(specTransport({ name: 'b', url: 'https://x' })).toBe('http');
    expect(specTransport({ name: 'c' })).toBe('unknown');
  });
  it('extracts the spec list from the standard mcpServers format', () => {
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
  it('returns an empty array when mcpServers is absent', () => {
    expect(readClaudeMcpConfig('{}')).toEqual([]);
  });
  it('returns an empty array for broken JSON (never throws)', () => {
    expect(readClaudeMcpConfig('{oops')).toEqual([]);
  });
});

describe('headers pass-through (PAT-style http servers)', () => {
  it('carries the headers of an http server into the spec', () => {
    const json = JSON.stringify({ mcpServers: {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/',
                headers: { Authorization: 'Bearer ghp_test123' } } } });
    const specs = readClaudeMcpConfig(json);
    expect(specs[0].headers).toEqual({ Authorization: 'Bearer ghp_test123' });
  });
  it('leaves headers undefined when there are none', () => {
    const json = JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://a' } } });
    expect(readClaudeMcpConfig(json)[0].headers).toBeUndefined();
  });
});
