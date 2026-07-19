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
    expect(names).toHaveLength(1);
    expect(names).toContain('shared-db');
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

describe('strict-write 순서 보장 (모든 쓰기 대상을 쓰기 전에 먼저 읽는다)', () => {
  it('enableServer: settings.json이 깨져 있으면 throw + claude.json·스태시 모두 미변경', () => {
    put('claude-user.json', paths.claudeJsonPath);
    disableServer(paths, 'lenstest'); // 스태시에 이동시켜 둔다
    const cjBefore = fs.readFileSync(paths.claudeJsonPath, 'utf8');
    const stashBefore = fs.readFileSync(paths.stashPath, 'utf8');
    put('broken.json', paths.settingsPath);

    expect(() => enableServer(paths, 'lenstest')).toThrow();

    expect(fs.readFileSync(paths.claudeJsonPath, 'utf8')).toBe(cjBefore);
    expect(fs.readFileSync(paths.stashPath, 'utf8')).toBe(stashBefore);
  });

  it('disableServer: claude.json과 .mcp.json 양쪽에 있는 이름 + 깨진 settings.json → throw + claude.json·스태시 모두 미변경', () => {
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

describe('disableServer — 크래시 복구 (스태시-먼저 순서의 중간 상태)', () => {
  it('스태시엔 이미 있지만 claude.json엔 아직 남아있는 경우 재호출로 claude.json만 정리하고 스태시는 보존한다', () => {
    put('claude-user.json', paths.claudeJsonPath); // claude.json엔 여전히 lenstest가 남아있음
    const crashedEntry = {
      origin: { kind: 'user' },
      spec: { command: 'node', args: ['server.js'], env: { PORT: '3100' } },
      disabledAt: '2020-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(paths.stashPath, JSON.stringify({ lenstest: crashedEntry }));

    disableServer(paths, 'lenstest');

    const cj = readJson(paths.claudeJsonPath);
    expect(cj.mcpServers.lenstest).toBeUndefined(); // claude.json 정리됨
    const stash = readJson(paths.stashPath);
    expect(stash.lenstest).toEqual(crashedEntry); // 기존 스태시 항목은 덮어쓰지 않음 (disabledAt 그대로)
  });
});

describe('enableServer — 사용자가 스태시 이후 수동으로 재등록한 서버 보호', () => {
  it('claude.json에 같은 이름이 이미 있으면 스태시된 옛 스펙으로 덮어쓰지 않고, 스태시 항목은 제거한다', () => {
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
    expect(cj.mcpServers.lenstest).toEqual(userSpec); // 사용자의 새 정의 보존
    const stash = readJson(paths.stashPath);
    expect(stash.lenstest).toBeUndefined(); // 스태시 항목은 정리됨
  });
});

describe('disableServer — 어디에도 없는 서버', () => {
  it('no-op: 파일도 생성하지 않고 throw도 하지 않는다', () => {
    expect(() => disableServer(paths, 'ghost')).not.toThrow();
    expect(fs.existsSync(paths.claudeJsonPath)).toBe(false);
    expect(fs.existsSync(paths.stashPath)).toBe(false);
    expect(fs.existsSync(paths.settingsPath)).toBe(false);
  });
});
