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
  it('아무 파일도 없으면 빈 배열', () => {
    expect(listManagedServers(paths)).toEqual([]);
  });
  it('유저 전역(top-level·projects)과 .mcp.json 서버를 수집한다', () => {
    put('claude-user.json', paths.claudeJsonPath);
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    const byName = new Map(listManagedServers(paths).map((m) => [m.name, m]));
    expect(byName.get('lenstest')).toEqual({ name: 'lenstest', enabled: true, origins: ['user'] });
    expect(byName.get('projserver')).toEqual({ name: 'projserver', enabled: true, origins: ['user'] });
    expect(byName.get('shared-db')).toEqual({ name: 'shared-db', enabled: true, origins: ['project'] });
  });
  it('스태시에 있는 서버는 enabled=false로 표시된다 (계속 보임 — 복원용)', () => {
    put('stash-basic.json', paths.stashPath);
    const byName = new Map(listManagedServers(paths).map((m) => [m.name, m]));
    expect(byName.get('oldserver')).toEqual({ name: 'oldserver', enabled: false, origins: ['user'] });
  });
  it('disabledMcpjsonServers에 있는 .mcp.json 서버는 enabled=false', () => {
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ disabledMcpjsonServers: ['shared-db'] }));
    const byName = new Map(listManagedServers(paths).map((m) => [m.name, m]));
    expect(byName.get('shared-db')!.enabled).toBe(false);
  });
  it('깨진 파일은 건너뛰고 나머지는 수집한다 (읽기 관대)', () => {
    put('broken.json', paths.claudeJsonPath);
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    const names = listManagedServers(paths).map((m) => m.name);
    expect(names).toEqual(['shared-db']);
  });
});

describe('disableServer — 유저 전역(~/.claude.json)', () => {
  beforeEach(() => put('claude-user.json', paths.claudeJsonPath));

  it('top-level 서버를 스태시로 이동하고 claude.json에서 제거한다', () => {
    disableServer(paths, 'lenstest');
    const cj = readJson(paths.claudeJsonPath);
    expect(cj.mcpServers.lenstest).toBeUndefined();
    expect(cj.oauthAccount.email).toBe('user@example.com'); // 다른 키 보존
    const stash = readJson(paths.stashPath);
    expect(stash.lenstest.origin).toEqual({ kind: 'user' });
    expect(stash.lenstest.spec).toEqual({ command: 'node', args: ['server.js'], env: { PORT: '3100' } });
  });
  it('projects.<path> 서버는 user-project origin으로 스태시된다', () => {
    disableServer(paths, 'projserver');
    const cj = readJson(paths.claudeJsonPath);
    expect(cj.projects['/Users/x/proj'].mcpServers.projserver).toBeUndefined();
    expect(cj.projects['/Users/x/proj'].allowedTools).toEqual([]); // 형제 키 보존
    const stash = readJson(paths.stashPath);
    expect(stash.projserver.origin).toEqual({ kind: 'user-project', projectPath: '/Users/x/proj' });
  });
  it('쓰기 전 claude.json 백업을 남긴다', () => {
    const before = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    disableServer(paths, 'lenstest');
    expect(fs.readFileSync(`${paths.claudeJsonPath}.mcplens.bak`, 'utf8')).toBe(before);
  });
  it('claude.json이 깨져 있으면 throw + 미변경 (쓰기 엄격)', () => {
    put('broken.json', paths.claudeJsonPath);
    const before = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    expect(() => disableServer(paths, 'lenstest')).toThrow();
    expect(fs.readFileSync(paths.claudeJsonPath, 'utf8')).toBe(before);
    expect(fs.existsSync(paths.stashPath)).toBe(false);
  });
  it('이미 스태시된 서버는 no-op (멱등)', () => {
    disableServer(paths, 'lenstest');
    const stashBefore = fs.readFileSync(paths.stashPath, 'utf8');
    disableServer(paths, 'lenstest');
    expect(fs.readFileSync(paths.stashPath, 'utf8')).toBe(stashBefore);
  });
});

describe('disableServer — 프로젝트 .mcp.json', () => {
  it('disabledMcpjsonServers에 이름을 추가한다 (.mcp.json은 건드리지 않음)', () => {
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    const mcpBefore = fs.readFileSync(paths.mcpJsonPaths[0], 'utf8');
    disableServer(paths, 'shared-db');
    expect(readJson(paths.settingsPath).disabledMcpjsonServers).toEqual(['shared-db']);
    expect(fs.readFileSync(paths.mcpJsonPaths[0], 'utf8')).toBe(mcpBefore);
    expect(fs.existsSync(paths.stashPath)).toBe(false); // 스태시 미사용
  });
  it('settings의 기존 키를 보존한다', () => {
    put('mcp-project.json', paths.mcpJsonPaths[0]);
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ model: 'opus' }));
    disableServer(paths, 'shared-db');
    const s = readJson(paths.settingsPath);
    expect(s.model).toBe('opus');
    expect(s.disabledMcpjsonServers).toEqual(['shared-db']);
  });
});

describe('enableServer', () => {
  it('스태시의 top-level 서버를 원위치로 무손실 복원한다', () => {
    put('claude-user.json', paths.claudeJsonPath);
    const specBefore = readJson(paths.claudeJsonPath).mcpServers.lenstest;
    disableServer(paths, 'lenstest');
    enableServer(paths, 'lenstest');
    expect(readJson(paths.claudeJsonPath).mcpServers.lenstest).toEqual(specBefore);
    expect(readJson(paths.stashPath)).toEqual({}); // 스태시 비워짐
  });
  it('user-project 서버를 원래 프로젝트 경로로 복원한다', () => {
    put('claude-user.json', paths.claudeJsonPath);
    disableServer(paths, 'projserver');
    enableServer(paths, 'projserver');
    expect(readJson(paths.claudeJsonPath).projects['/Users/x/proj'].mcpServers.projserver)
      .toEqual({ url: 'https://proj.example/mcp' });
  });
  it('disabledMcpjsonServers에서 해당 이름만 제거한다', () => {
    fs.writeFileSync(paths.settingsPath,
      JSON.stringify({ disabledMcpjsonServers: ['shared-db', 'other'] }));
    enableServer(paths, 'shared-db');
    expect(readJson(paths.settingsPath).disabledMcpjsonServers).toEqual(['other']);
  });
  it('어디에도 없는 서버는 no-op (멱등)', () => {
    expect(() => enableServer(paths, 'ghost')).not.toThrow();
    expect(fs.existsSync(paths.claudeJsonPath)).toBe(false);
  });
});
