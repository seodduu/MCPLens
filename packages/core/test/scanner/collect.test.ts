import { describe, it, expect } from 'vitest';
import { collectServerSpecs } from '../../src/scanner/configs.js';

describe('collectServerSpecs', () => {
  it('top-level 과 projects mcpServers 를 병합한다', () => {
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

  it('서버명으로 중복 제거하며 top-level 을 우선한다', () => {
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

  it('command 없는 (http 등) 서버는 skip 목록에 넣고 스펙에서 제외한다', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp' },
        remote: { type: 'http', url: 'https://example.com/mcp' },
      },
    });
    const { specs, skipped } = collectServerSpecs(json);
    expect(specs.map((s) => s.name)).toEqual(['github']);
    expect(skipped).toEqual(['remote']);
  });

  it('잘못된 JSON 은 throw 하지 않고 빈 결과를 반환한다', () => {
    expect(collectServerSpecs('{not json')).toEqual({ specs: [], skipped: [] });
  });
});
