import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { configSources, collectFromSource, collectAllSpecs } from '../../src/scanner/sources.js';

const CODEX_TOML_FIXTURE = `
[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"
startup_timeout_sec = 120.0

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/testuser/.codex"

[mcp_servers.computer-use]
command = "./SkyComputerUseClient"
args = ["mcp"]
cwd = "."
enabled = false
`;

const GEMINI_JSON_FIXTURE = JSON.stringify({
  mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  },
});

const MCP_JSON_FIXTURE = JSON.stringify({
  mcpServers: {
    fs: { command: 'fs-mcp', args: ['--stdio'] },
  },
});

describe('collectFromSource(codex)', () => {
  it('mcp_servers 테이블에서 stdio spec 추출, enabled=false는 skipped', () => {
    const r = collectFromSource('codex', CODEX_TOML_FIXTURE);
    expect(r.specs.map((s) => s.name)).toEqual(['node_repl']);
    expect(r.specs[0].command).toBe(
      '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl',
    );
    expect(r.specs[0].env?.CODEX_HOME).toBe('/Users/testuser/.codex');
    expect(r.skipped).toContain('computer-use');
  });

  it('깨진 TOML은 빈 결과', () => {
    expect(collectFromSource('codex', '[broken')).toEqual({ specs: [], skipped: [] });
  });

  it('mcp_servers 키가 없으면 빈 결과', () => {
    expect(collectFromSource('codex', '')).toEqual({ specs: [], skipped: [] });
  });
});

describe('collectFromSource(gemini)', () => {
  it('mcpServers 표준 포맷 재사용', () => {
    const r = collectFromSource('gemini', GEMINI_JSON_FIXTURE);
    expect(r.specs).toEqual([
      { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: undefined },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('빈 텍스트/파싱 실패는 빈 결과', () => {
    expect(collectFromSource('gemini', '')).toEqual({ specs: [], skipped: [] });
    expect(collectFromSource('gemini', '{broken')).toEqual({ specs: [], skipped: [] });
  });
});

describe('collectFromSource(claude-project)', () => {
  it('.mcp.json 표준 포맷을 파싱한다', () => {
    const r = collectFromSource('claude-project', MCP_JSON_FIXTURE);
    expect(r.specs.map((s) => s.name)).toEqual(['fs']);
  });
});

describe('collectFromSource(claude-user)', () => {
  it('~/.claude.json 표준 포맷(top-level + projects)을 파싱한다', () => {
    const json = JSON.stringify({
      mcpServers: { github: { command: 'gh-mcp', args: [] } },
    });
    const r = collectFromSource('claude-user', json);
    expect(r.specs.map((s) => s.name)).toEqual(['github']);
  });
});

const CLAUDE_USER_JSON_FIXTURE = JSON.stringify({
  mcpServers: { github: { command: 'gh-mcp', args: [] } },
  projects: {
    '/home/u/proj-a': { mcpServers: {} },
    '/home/u/proj-b': { mcpServers: {} },
  },
});

describe('configSources', () => {
  it('4종 경로를 os.homedir 기반 절대경로로 반환하고, claude-project는 주입된 fixture에서 결정적으로 유도된다', () => {
    const sources = configSources({ claudeUserJson: CLAUDE_USER_JSON_FIXTURE });

    const claudeUser = sources.find((s) => s.kind === 'claude-user')!;
    expect(claudeUser.filePath).toBe(path.join(os.homedir(), '.claude.json'));
    expect(path.isAbsolute(claudeUser.filePath)).toBe(true);

    const codex = sources.find((s) => s.kind === 'codex')!;
    expect(codex.filePath).toBe(path.join(os.homedir(), '.codex', 'config.toml'));

    const gemini = sources.find((s) => s.kind === 'gemini')!;
    expect(gemini.filePath).toBe(path.join(os.homedir(), '.gemini', 'settings.json'));

    const claudeProjects = sources.filter((s) => s.kind === 'claude-project');
    expect(claudeProjects.map((s) => s.filePath).sort()).toEqual(
      [path.join('/home/u/proj-a', '.mcp.json'), path.join('/home/u/proj-b', '.mcp.json')].sort(),
    );
  });

  it('claudeUserJson이 깨져있거나 projects가 없으면 claude-project 항목이 없다', () => {
    expect(
      configSources({ claudeUserJson: '{broken' }).filter((s) => s.kind === 'claude-project'),
    ).toEqual([]);
    expect(
      configSources({ claudeUserJson: '{}' }).filter((s) => s.kind === 'claude-project'),
    ).toEqual([]);
  });
});

describe('collectAllSpecs 귀속', () => {
  it('반환에 attribution과 replaceable이 있다', () => {
    const r = collectAllSpecs();
    expect(r.attribution).toBeInstanceOf(Map);
    expect(r.replaceable).toBeInstanceOf(Set);
  });

  it('발견된 모든 서버가 attribution에 담긴다', () => {
    const r = collectAllSpecs();
    for (const spec of r.specs) {
      expect(r.attribution.has(spec.name)).toBe(true);
      expect(r.attribution.get(spec.name)!.size).toBeGreaterThan(0);
    }
  });

  it('specs는 여전히 이름 기준으로 dedupe된다 (서버당 1회 스캔)', () => {
    const r = collectAllSpecs();
    const names = r.specs.map((s) => s.name);
    expect(names.length).toBe(new Set(names).size);
  });
});
