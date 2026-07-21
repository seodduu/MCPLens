import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { configSources, collectFromSource, collectAllSpecs, collectFromSources, type ConfigSource } from '../../src/scanner/sources.js';

/** 실제 Node fs 오류 형태를 흉내낸다. */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

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

});

describe('collectFromSources (주입된 readFile로 ENOENT/EACCES 구분 검증)', () => {
  const claudeUserSource: ConfigSource = { kind: 'claude-user', filePath: '/home/u/.claude.json' };
  const claudeProjectSource: ConfigSource = { kind: 'claude-project', filePath: '/home/u/proj/.mcp.json' };
  const codexSource: ConfigSource = { kind: 'codex', filePath: '/home/u/.codex/config.toml' };
  const geminiSource: ConfigSource = { kind: 'gemini', filePath: '/home/u/.gemini/settings.json' };

  it('ENOENT를 던지면 그 클라이언트가 replaceable에 포함된다', () => {
    const r = collectFromSources([codexSource], () => {
      throw fsError('ENOENT');
    });
    expect(r.replaceable.has('codex')).toBe(true);
  });

  it('EACCES(권한 오류)를 던지면 그 클라이언트가 replaceable에서 제외된다', () => {
    const r = collectFromSources([codexSource], () => {
      throw fsError('EACCES');
    });
    expect(r.replaceable.has('codex')).toBe(false);
  });

  it('code가 없는 일반 오류도 관찰 실패로 취급해 replaceable에서 제외된다', () => {
    const r = collectFromSources([geminiSource], () => {
      throw new Error('boom');
    });
    expect(r.replaceable.has('gemini-cli')).toBe(false);
  });

  it('claude-user는 정상, claude-project 하나가 오류면 claude-code 전체가 replaceable에서 제외된다', () => {
    const r = collectFromSources([claudeUserSource, claudeProjectSource], (p) => {
      if (p === claudeUserSource.filePath) {
        return JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } });
      }
      throw fsError('EACCES');
    });
    expect(r.replaceable.has('claude-code')).toBe(false);
    // 정상적으로 읽힌 claude-user의 서버는 여전히 attribution에 담긴다.
    expect(r.attribution.get('github')?.has('claude-code')).toBe(true);
  });

  it('서버가 실제로 attribution에 올바른 클라이언트로 담긴다', () => {
    const r = collectFromSources([codexSource], () => CODEX_TOML_FIXTURE);
    expect(r.specs.map((s) => s.name)).toEqual(['node_repl']);
    expect(r.attribution.get('node_repl')).toEqual(new Set(['codex']));
  });

  it('같은 이름 서버가 두 소스에 있으면 specs는 1개로 dedupe되고 attribution에는 두 클라이언트 모두 담긴다', () => {
    const sameNameCodex = `
[mcp_servers.shared]
command = "shared-cmd"
`;
    const sameNameGemini = JSON.stringify({
      mcpServers: { shared: { command: 'shared-cmd-2', args: [] } },
    });
    const r = collectFromSources([codexSource, geminiSource], (p) => {
      if (p === codexSource.filePath) return sameNameCodex;
      if (p === geminiSource.filePath) return sameNameGemini;
      throw fsError('ENOENT');
    });
    const names = r.specs.map((s) => s.name);
    expect(names.filter((n) => n === 'shared').length).toBe(1);
    expect(r.attribution.get('shared')).toEqual(new Set(['codex', 'gemini-cli']));
  });
});
