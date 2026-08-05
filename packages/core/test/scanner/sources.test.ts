import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { configSources, collectFromSource, collectAllSpecs, collectFromSources, type ConfigSource } from '../../src/scanner/sources.js';
import { computeEndpointHash } from '../../src/scanner/serverIdentity.js';

/** Mimics the shape of a real Node fs error. */
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
  it('extracts stdio specs from the mcp_servers table and reports enabled=false as skipped', () => {
    const r = collectFromSource('codex', CODEX_TOML_FIXTURE);
    expect(r.specs.map((s) => s.name)).toEqual(['node_repl']);
    expect(r.specs[0].command).toBe(
      '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl',
    );
    expect(r.specs[0].env?.CODEX_HOME).toBe('/Users/testuser/.codex');
    expect(r.skipped).toContain('computer-use');
  });

  it('returns an empty result for broken TOML', () => {
    expect(collectFromSource('codex', '[broken')).toEqual({ specs: [], skipped: [] });
  });

  it('returns an empty result when the mcp_servers key is absent', () => {
    expect(collectFromSource('codex', '')).toEqual({ specs: [], skipped: [] });
  });
});

describe('collectFromSource(gemini)', () => {
  it('reuses the standard mcpServers format', () => {
    const r = collectFromSource('gemini', GEMINI_JSON_FIXTURE);
    expect(r.specs).toEqual([
      { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: undefined },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('returns an empty result for empty text or a parse failure', () => {
    expect(collectFromSource('gemini', '')).toEqual({ specs: [], skipped: [] });
    expect(collectFromSource('gemini', '{broken')).toEqual({ specs: [], skipped: [] });
  });
});

describe('collectFromSource(claude-project)', () => {
  it('parses the standard .mcp.json format', () => {
    const r = collectFromSource('claude-project', MCP_JSON_FIXTURE);
    expect(r.specs.map((s) => s.name)).toEqual(['fs']);
  });
});

describe('collectFromSource(claude-user)', () => {
  it('parses the standard ~/.claude.json format (top-level plus projects)', () => {
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
  it('returns all four paths as os.homedir-based absolute paths, deriving claude-project deterministically from the injected fixture', () => {
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

  it('emits no claude-project entry when claudeUserJson is broken or has no projects', () => {
    expect(
      configSources({ claudeUserJson: '{broken' }).filter((s) => s.kind === 'claude-project'),
    ).toEqual([]);
    expect(
      configSources({ claudeUserJson: '{}' }).filter((s) => s.kind === 'claude-project'),
    ).toEqual([]);
  });
});

describe('collectAllSpecs attribution', () => {
  it('returns attribution and replaceable', () => {
    const r = collectAllSpecs();
    expect(r.attribution).toBeInstanceOf(Map);
    expect(r.replaceable).toBeInstanceOf(Set);
  });

});

describe('collectFromSources (verifying the ENOENT/EACCES distinction with an injected readFile)', () => {
  const claudeUserSource: ConfigSource = { kind: 'claude-user', filePath: '/home/u/.claude.json' };
  const claudeProjectSource: ConfigSource = { kind: 'claude-project', filePath: '/home/u/proj/.mcp.json' };
  const codexSource: ConfigSource = { kind: 'codex', filePath: '/home/u/.codex/config.toml' };
  const geminiSource: ConfigSource = { kind: 'gemini', filePath: '/home/u/.gemini/settings.json' };

  it('includes the client in replaceable when it throws ENOENT', () => {
    const r = collectFromSources([codexSource], () => {
      throw fsError('ENOENT');
    });
    expect(r.replaceable.has('codex')).toBe(true);
  });

  it('excludes the client from replaceable when it throws EACCES (a permission error)', () => {
    const r = collectFromSources([codexSource], () => {
      throw fsError('EACCES');
    });
    expect(r.replaceable.has('codex')).toBe(false);
  });

  it('treats a generic error with no code as a failed observation too and excludes it from replaceable', () => {
    const r = collectFromSources([geminiSource], () => {
      throw new Error('boom');
    });
    expect(r.replaceable.has('gemini-cli')).toBe(false);
  });

  it('excludes the whole of claude-code from replaceable when claude-user is fine but one claude-project errors', () => {
    const r = collectFromSources([claudeUserSource, claudeProjectSource], (p) => {
      if (p === claudeUserSource.filePath) {
        return JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } });
      }
      throw fsError('EACCES');
    });
    expect(r.replaceable.has('claude-code')).toBe(false);
    // Servers from the claude-user source that read fine are still carried in attribution.
    expect(r.attribution.get('github')?.has('claude-code')).toBe(true);
  });

  it('really carries a server into attribution under the right client', () => {
    const r = collectFromSources([codexSource], () => CODEX_TOML_FIXTURE);
    expect(r.specs.map((s) => s.name)).toEqual(['node_repl']);
    expect(r.attribution.get('node_repl')).toEqual(new Set(['codex']));
  });

  it('dedupes specs to one and carries both clients in attribution when the same server name is in two sources', () => {
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

  it('returns the server identity per read source, excluding env and header values', () => {
    const codexWithEnv = `
[mcp_servers.secure]
command = "secure-cmd"
args = ["--stdio"]

[mcp_servers.secure.env]
TOKEN = "secret"
`;
    const claudeHttp = JSON.stringify({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://example.com/mcp?x=1',
          headers: { Authorization: 'Bearer secret' },
        },
      },
    });
    const r = collectFromSources([codexSource, claudeUserSource], (p) => {
      if (p === codexSource.filePath) return codexWithEnv;
      if (p === claudeUserSource.filePath) return claudeHttp;
      throw fsError('ENOENT');
    });

    expect(r.identities).toEqual([
      expect.objectContaining({
        client: 'claude-code',
        serverName: 'remote',
        sourceKind: 'claude-user',
        sourcePathHash: createHash('sha256').update(claudeUserSource.filePath).digest('hex'),
        transport: 'http',
        endpointHash: computeEndpointHash({ name: 'remote', url: 'https://example.com/mcp?x=1' }),
        conflictState: 'clear',
      }),
      expect.objectContaining({
        client: 'codex',
        serverName: 'secure',
        sourceKind: 'codex',
        sourcePathHash: createHash('sha256').update(codexSource.filePath).digest('hex'),
        transport: 'stdio',
        endpointHash: computeEndpointHash({ name: 'secure', command: 'secure-cmd', args: ['--stdio'] }),
        conflictState: 'clear',
      }),
    ]);
  });

  it('marks every identity as a conflict when one server name has more than one endpoint hash', () => {
    const sameNameCodex = `
[mcp_servers.shared]
command = "first-cmd"
`;
    const sameNameGemini = JSON.stringify({
      mcpServers: { shared: { command: 'second-cmd', args: [] } },
    });
    const r = collectFromSources([codexSource, geminiSource], (p) => {
      if (p === codexSource.filePath) return sameNameCodex;
      if (p === geminiSource.filePath) return sameNameGemini;
      throw fsError('ENOENT');
    });

    expect(r.specs).toEqual([{ name: 'shared', command: 'first-cmd', args: [], env: undefined }]);
    expect(r.identities.map((i) => [i.client, i.serverName, i.conflictState])).toEqual([
      ['codex', 'shared', 'conflict'],
      ['gemini-cli', 'shared', 'conflict'],
    ]);
  });
});
