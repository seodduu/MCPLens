import { describe, it, expect } from 'vitest';
import { collectServerSpecs } from '../../src/scanner/configs.js';
import { computeDefinitionSetHash } from '../../src/scanner/serverIdentity.js';

describe('collectServerSpecs', () => {
  it('merges top-level and projects mcpServers', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp', args: ['--stdio'] },
      },
      projects: {
        '/home/u/proj-a': {
          mcpServers: { fs: { command: 'fs-mcp', args: [] } },
        },
        '/home/u/proj-b': {
          mcpServers: { db: { command: 'db-mcp' } },
        },
      },
    });
    const { specs } = collectServerSpecs(json);
    const names = specs.map((s) => s.name).sort();
    expect(names).toEqual(['db', 'fs', 'github']);
    expect(specs.find((s) => s.name === 'github')!.args).toEqual(['--stdio']);
    expect(specs.find((s) => s.name === 'db')!.args).toEqual([]);
  });

  it('dedupes by server name and prefers top-level', () => {
    const json = JSON.stringify({
      mcpServers: { github: { command: 'top-cmd', args: ['top'] } },
      projects: {
        '/p': { mcpServers: { github: { command: 'proj-cmd', args: ['proj'] } } },
      },
    });
    const { specs } = collectServerSpecs(json);
    expect(specs).toHaveLength(1);
    expect(specs[0].command).toBe('top-cmd');
  });

  it('includes http servers with a url and skips only servers whose transport cannot be determined', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp' },
        remote: { type: 'http', url: 'https://example.com/mcp' },
        unknown: { type: 'http' },
        empty: {},
      },
    });
    const { specs, skipped } = collectServerSpecs(json);
    expect(specs.map((s) => s.name).sort()).toEqual(['github', 'remote']);
    expect(specs.find((s) => s.name === 'remote')!.url).toBe('https://example.com/mcp');
    expect(skipped.sort()).toEqual(['empty', 'unknown']);
  });

  it('returns an empty result for invalid JSON instead of throwing', () => {
    expect(collectServerSpecs('{not json')).toEqual({ specs: [], skipped: [] });
  });
});

describe('computeDefinitionSetHash', () => {
  it('builds a deterministic hash from the server name and sorted tool bodies', () => {
    const first = computeDefinitionSetHash('srv', [
      { toolName: 'b', description: null, inputSchema: { z: 1, a: { y: 2, x: 1 } } },
      { toolName: 'a', description: 'uses b', inputSchema: { list: [{ b: 1, a: 2 }] } },
    ]);
    const second = computeDefinitionSetHash('srv', [
      { toolName: 'a', description: 'uses b', inputSchema: { list: [{ a: 2, b: 1 }] } },
      { toolName: 'b', description: null, inputSchema: { a: { x: 1, y: 2 }, z: 1 } },
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(computeDefinitionSetHash('other', [
      { toolName: 'a', description: 'uses b', inputSchema: { list: [{ a: 2, b: 1 }] } },
      { toolName: 'b', description: null, inputSchema: { a: { x: 1, y: 2 }, z: 1 } },
    ])).not.toBe(first);
  });
});
