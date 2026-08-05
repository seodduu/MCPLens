import { describe, it, expect } from 'vitest';
import { collectServerSpecs } from '../src/scan-config.js';

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

  it('includes http(url) servers and skips only servers with an undeterminable transport (Wave 7A contract)', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp' },
        remote: { type: 'http', url: 'https://example.com/mcp' },
        mystery: {},
      },
    });
    const { specs, skipped } = collectServerSpecs(json);
    expect(specs.map((s) => s.name).sort()).toEqual(['github', 'remote']);
    expect(specs.find((s) => s.name === 'remote')!.url).toBe('https://example.com/mcp');
    expect(skipped).toEqual(['mystery']);
  });

  it('returns an empty result for invalid JSON instead of throwing', () => {
    expect(collectServerSpecs('{not json')).toEqual({ specs: [], skipped: [] });
  });
});
