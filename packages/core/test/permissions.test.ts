// packages/core/test/permissions.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mcpDenyRule, readDeniedMcpTools, denyMcpTool, allowMcpTool } from '../src/permissions/claudeSettings.js';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures', 'claude-settings');

let dir: string;
let file: string;
const useFixture = (name: string) => {
  fs.copyFileSync(path.join(FIXTURES, name), file);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcplens-perm-'));
  file = path.join(dir, 'settings.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('mcpDenyRule', () => {
  it('mcp__server__tool 형식으로 조립한다', () => {
    expect(mcpDenyRule('github', 'search')).toBe('mcp__github__search');
  });
});

describe('readDeniedMcpTools', () => {
  it('파일이 없으면 빈 Set', () => {
    expect(readDeniedMcpTools(file).size).toBe(0);
  });
  it('permissions 키가 없으면 빈 Set', () => {
    useFixture('no-permissions.json');
    expect(readDeniedMcpTools(file).size).toBe(0);
  });
  it('mcp__ 규칙만 골라 원형 그대로 반환한다', () => {
    useFixture('basic.json');
    expect(readDeniedMcpTools(file)).toEqual(new Set(['mcp__github__search']));
  });
  it('깨진 JSON이면 throw한다', () => {
    useFixture('broken.json');
    expect(() => readDeniedMcpTools(file)).toThrow();
  });
});

describe('denyMcpTool', () => {
  it('deny 배열에 규칙을 추가하고 다른 키를 보존한다', () => {
    useFixture('basic.json');
    denyMcpTool(file, 'notion', 'notion-search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny).toContain('mcp__notion__notion-search');
    expect(after.permissions.deny).toContain('Read(.env)');   // 비-mcp 항목 보존
    expect(after.permissions.allow).toEqual(['Bash(npm run *)']); // 형제 키 보존
    expect(after.model).toBe('opus');                          // 루트 키 보존
  });
  it('이미 있으면 no-op (멱등)', () => {
    useFixture('basic.json');
    denyMcpTool(file, 'github', 'search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny.filter((r: string) => r === 'mcp__github__search')).toHaveLength(1);
  });
  it('파일이 없으면 새로 생성한다', () => {
    denyMcpTool(file, 'github', 'search');
    expect(readDeniedMcpTools(file)).toEqual(new Set(['mcp__github__search']));
  });
  it('permissions 키가 없으면 만들어서 추가한다', () => {
    useFixture('no-permissions.json');
    denyMcpTool(file, 'github', 'search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny).toEqual(['mcp__github__search']);
    expect(after.model).toBe('opus');
  });
  it('쓰기 전 .mcplens.bak 백업을 남긴다', () => {
    useFixture('basic.json');
    const before = fs.readFileSync(file, 'utf8');
    denyMcpTool(file, 'notion', 'notion-search');
    expect(fs.readFileSync(`${file}.mcplens.bak`, 'utf8')).toBe(before);
  });
  it('깨진 JSON이면 throw하고 파일을 건드리지 않는다', () => {
    useFixture('broken.json');
    const before = fs.readFileSync(file, 'utf8');
    expect(() => denyMcpTool(file, 'github', 'search')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('allowMcpTool', () => {
  it('해당 규칙만 제거하고 나머지 deny를 보존한다', () => {
    useFixture('basic.json');
    allowMcpTool(file, 'github', 'search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny).toEqual(['Read(.env)']);
  });
  it('규칙이 없으면 no-op — 파일도 쓰지 않는다(백업 없음)', () => {
    useFixture('basic.json');
    allowMcpTool(file, 'linear', 'create_issue');
    expect(fs.existsSync(`${file}.mcplens.bak`)).toBe(false);
  });
  it('파일이 없으면 no-op', () => {
    expect(() => allowMcpTool(file, 'github', 'search')).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
