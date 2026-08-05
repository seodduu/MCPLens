import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listManagedServers, disableServer, enableServer,
  type ClaudeConfigPaths } from '../src/permissions/claudeServers.js';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures', 'claude-settings');

let dir: string;
let paths: ClaudeConfigPaths;
const put = (fixture: string, dest: string) =>
  fs.copyFileSync(path.join(FIXTURES, fixture), dest);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcplens-srv-'));
  paths = {
    settingsPath: path.join(dir, 'settings.json'),
    claudeJsonPath: path.join(dir, 'claude.json'),
    stashPath: path.join(dir, 'disabled-servers.json'),
    mcpJsonPaths: [path.join(dir, 'mcp-project.json')],
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('listManagedServers', () => {
  it('returns an empty array when there is no file at all', () => {
    expect(listManagedServers(paths)).toEqual([]);
  });
  it('collects servers from the user-global file (top-level and projects) and .mcp.json', () => {
    put('claude-user.json', paths.claudeJsonPath);
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    const byName = new Map(listManagedServers(paths).map((m) => [m.name, m]));
    expect(byName.get('lenstest')).toEqual({ name: 'lenstest', enabled: true, origins: ['user'] });
    expect(byName.get('projserver')).toEqual({ name: 'projserver', enabled: true, origins: ['user'] });
    expect(byName.get('shared-db')).toEqual({ name: 'shared-db', enabled: true, origins: ['project'] });
  });
  it('marks a stashed server enabled=false (still visible, for restoring)', () => {
    put('stash-basic.json', paths.stashPath);
    const byName = new Map(listManagedServers(paths).map((m) => [m.name, m]));
    expect(byName.get('oldserver')).toEqual({ name: 'oldserver', enabled: false, origins: ['user'] });
  });
  it('marks a .mcp.json server in disabledMcpjsonServers enabled=false', () => {
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ disabledMcpjsonServers: ['shared-db'] }));
    const byName = new Map(listManagedServers(paths).map((m) => [m.name, m]));
    expect(byName.get('shared-db')!.enabled).toBe(false);
  });
  it('skips a broken file and collects the rest (lenient reads)', () => {
    put('broken.json', paths.claudeJsonPath);
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    const names = listManagedServers(paths).map((m) => m.name);
    expect(names).toHaveLength(1);
    expect(names).toContain('shared-db');
  });
});

describe('disableServer on the user-global ~/.claude.json', () => {
  beforeEach(() => put('claude-user.json', paths.claudeJsonPath));

  it('moves a top-level server into the stash and removes it from claude.json', () => {
    disableServer(paths, 'lenstest');
    const cj = readJson(paths.claudeJsonPath);
    expect(cj.mcpServers.lenstest).toBeUndefined();
    expect(cj.oauthAccount.email).toBe('user@example.com'); // other keys preserved
    const stash = readJson(paths.stashPath);
    expect(stash.lenstest.origin).toEqual({ kind: 'user' });
    expect(stash.lenstest.spec).toEqual({ command: 'node', args: ['server.js'], env: { PORT: '3100' } });
  });
  it('stashes a projects.<path> server with the user-project origin', () => {
    disableServer(paths, 'projserver');
    const cj = readJson(paths.claudeJsonPath);
    expect(cj.projects['/Users/x/proj'].mcpServers.projserver).toBeUndefined();
    expect(cj.projects['/Users/x/proj'].allowedTools).toEqual([]); // sibling keys preserved
    const stash = readJson(paths.stashPath);
    expect(stash.projserver.origin).toEqual({ kind: 'user-project', projectPath: '/Users/x/proj' });
  });
  it('leaves a claude.json backup before writing', () => {
    const before = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    disableServer(paths, 'lenstest');
    expect(fs.readFileSync(`${paths.claudeJsonPath}.mcplens.bak`, 'utf8')).toBe(before);
  });
  it('throws and changes nothing when claude.json is broken (strict writes)', () => {
    put('broken.json', paths.claudeJsonPath);
    const before = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    expect(() => disableServer(paths, 'lenstest')).toThrow();
    expect(fs.readFileSync(paths.claudeJsonPath, 'utf8')).toBe(before);
    expect(fs.existsSync(paths.stashPath)).toBe(false);
  });
  it('is a no-op for an already-stashed server (idempotent)', () => {
    disableServer(paths, 'lenstest');
    const stashBefore = fs.readFileSync(paths.stashPath, 'utf8');
    const cjBefore = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    disableServer(paths, 'lenstest');
    expect(fs.readFileSync(paths.stashPath, 'utf8')).toBe(stashBefore);
    expect(fs.readFileSync(paths.claudeJsonPath, 'utf8')).toBe(cjBefore);
  });
});

describe('disableServer on a project .mcp.json', () => {
  it('adds the name to disabledMcpjsonServers (leaving .mcp.json untouched)', () => {
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    const mcpBefore = fs.readFileSync(paths.mcpJsonPaths[0], 'utf8');
    disableServer(paths, 'shared-db');
    expect(readJson(paths.settingsPath).disabledMcpjsonServers).toEqual(['shared-db']);
    expect(fs.readFileSync(paths.mcpJsonPaths[0], 'utf8')).toBe(mcpBefore);
    expect(fs.existsSync(paths.stashPath)).toBe(false); // the stash is unused
  });
  it('preserves the existing keys of settings', () => {
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ model: 'opus' }));
    disableServer(paths, 'shared-db');
    const s = readJson(paths.settingsPath);
    expect(s.model).toBe('opus');
    expect(s.disabledMcpjsonServers).toEqual(['shared-db']);
  });
});

describe('enableServer', () => {
  it('restores a stashed top-level server in place, losslessly', () => {
    put('claude-user.json', paths.claudeJsonPath);
    const specBefore = readJson(paths.claudeJsonPath).mcpServers.lenstest;
    disableServer(paths, 'lenstest');
    enableServer(paths, 'lenstest');
    expect(readJson(paths.claudeJsonPath).mcpServers.lenstest).toEqual(specBefore);
    expect(readJson(paths.stashPath)).toEqual({}); // the stash is emptied
  });
  it('restores a user-project server to its original project path', () => {
    put('claude-user.json', paths.claudeJsonPath);
    disableServer(paths, 'projserver');
    enableServer(paths, 'projserver');
    expect(readJson(paths.claudeJsonPath).projects['/Users/x/proj'].mcpServers.projserver)
      .toEqual({ url: 'https://proj.example/mcp' });
  });
  it('removes only that name from disabledMcpjsonServers', () => {
    fs.writeFileSync(paths.settingsPath,
      JSON.stringify({ disabledMcpjsonServers: ['shared-db', 'other'] }));
    enableServer(paths, 'shared-db');
    expect(readJson(paths.settingsPath).disabledMcpjsonServers).toEqual(['other']);
  });
  it('is a no-op for a server that exists nowhere (idempotent)', () => {
    expect(() => enableServer(paths, 'ghost')).not.toThrow();
    expect(fs.existsSync(paths.claudeJsonPath)).toBe(false);
  });
});

describe('strict-write ordering (every write target is read before anything is written)', () => {
  it('enableServer: throws on a broken settings.json and leaves both claude.json and the stash unchanged', () => {
    put('claude-user.json', paths.claudeJsonPath);
    disableServer(paths, 'lenstest'); // move it into the stash first
    const cjBefore = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    const stashBefore = fs.readFileSync(paths.stashPath, 'utf8');
    put('broken.json', paths.settingsPath);

    expect(() => enableServer(paths, 'lenstest')).toThrow();

    expect(fs.readFileSync(paths.claudeJsonPath, 'utf8')).toBe(cjBefore);
    expect(fs.readFileSync(paths.stashPath, 'utf8')).toBe(stashBefore);
  });

  it('disableServer: a name in both claude.json and .mcp.json with a broken settings.json throws and leaves claude.json and the stash unchanged', () => {
    fs.writeFileSync(paths.claudeJsonPath, JSON.stringify({
      mcpServers: { dualserver: { command: 'node', args: ['dual.js'] } },
    }));
    fs.writeFileSync(paths.mcpJsonPaths[0], JSON.stringify({
      mcpServers: { dualserver: { command: 'npx', args: ['dual-mcp'] } },
    }));
    put('broken.json', paths.settingsPath);
    const cjBefore = fs.readFileSync(paths.claudeJsonPath, 'utf8');

    expect(() => disableServer(paths, 'dualserver')).toThrow();

    expect(fs.readFileSync(paths.claudeJsonPath, 'utf8')).toBe(cjBefore);
    expect(fs.existsSync(paths.stashPath)).toBe(false);
  });
});

describe('disableServer crash recovery (the intermediate state of stash-first ordering)', () => {
  it('cleans only claude.json on a repeat call when the stash already has it but claude.json still does, preserving the stash', () => {
    put('claude-user.json', paths.claudeJsonPath); // claude.json still holds lenstest
    const crashedEntry = {
      origin: { kind: 'user' },
      spec: { command: 'node', args: ['server.js'], env: { PORT: '3100' } },
      disabledAt: '2020-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(paths.stashPath, JSON.stringify({ lenstest: crashedEntry }));

    disableServer(paths, 'lenstest');

    const cj = readJson(paths.claudeJsonPath);
    expect(cj.mcpServers.lenstest).toBeUndefined(); // claude.json cleaned
    const stash = readJson(paths.stashPath);
    expect(stash.lenstest).toEqual(crashedEntry); // the existing stash entry is not overwritten (disabledAt intact)
  });
});

describe('enableServer protects a server the user re-registered by hand after the stash', () => {
  it('does not overwrite an existing claude.json entry with the stale stashed spec, and clears the stash entry', () => {
    const staleEntry = {
      origin: { kind: 'user' },
      spec: { command: 'node', args: ['old-server.js'] },
      disabledAt: '2020-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(paths.stashPath, JSON.stringify({ lenstest: staleEntry }));
    const userSpec = { command: 'node', args: ['new-server.js'], env: { PORT: '4200' } };
    fs.writeFileSync(paths.claudeJsonPath, JSON.stringify({
      mcpServers: { lenstest: userSpec },
    }));

    enableServer(paths, 'lenstest');

    const cj = readJson(paths.claudeJsonPath);
    expect(cj.mcpServers.lenstest).toEqual(userSpec); // the user's new definition is preserved
    const stash = readJson(paths.stashPath);
    expect(stash.lenstest).toBeUndefined(); // the stash entry is cleaned up
  });
});

describe('disableServer re-disabling a server the user re-registered with a different spec after the stash', () => {
  it('updates the stash spec to the newly removed one, keeps the original disabledAt and removes it from claude.json', () => {
    const originalDisabledAt = '2020-01-01T00:00:00.000Z';
    const staleEntry = {
      origin: { kind: 'user' },
      spec: { command: 'node', args: ['old-server.js'] },
      disabledAt: originalDisabledAt,
    };
    fs.writeFileSync(paths.stashPath, JSON.stringify({ lenstest: staleEntry }));
    const newSpec = { command: 'node', args: ['new-server.js'], env: { PORT: '4200' } };
    fs.writeFileSync(paths.claudeJsonPath, JSON.stringify({
      mcpServers: { lenstest: newSpec },
    }));

    disableServer(paths, 'lenstest');

    const stash = readJson(paths.stashPath);
    expect(stash.lenstest.spec).toEqual(newSpec); // the spec just removed, not the stale one
    expect(stash.lenstest.disabledAt).toBe(originalDisabledAt); // the first disable time is preserved
    const cj = readJson(paths.claudeJsonPath);
    expect(cj.mcpServers.lenstest).toBeUndefined(); // removed from claude.json
  });
});

describe('disableServer for a server that exists nowhere', () => {
  it('is a no-op: it creates no file and throws nothing', () => {
    expect(() => disableServer(paths, 'ghost')).not.toThrow();
    expect(fs.existsSync(paths.claudeJsonPath)).toBe(false);
    expect(fs.existsSync(paths.stashPath)).toBe(false);
    expect(fs.existsSync(paths.settingsPath)).toBe(false);
  });
});
