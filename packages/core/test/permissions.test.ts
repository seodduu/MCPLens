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
  it('assembles the mcp__server__tool form', () => {
    expect(mcpDenyRule('github', 'search')).toBe('mcp__github__search');
  });
});

describe('readDeniedMcpTools', () => {
  it('returns an empty Set when the file is missing', () => {
    expect(readDeniedMcpTools(file).size).toBe(0);
  });
  it('returns an empty Set when the permissions key is absent', () => {
    useFixture('no-permissions.json');
    expect(readDeniedMcpTools(file).size).toBe(0);
  });
  it('returns only the mcp__ rules, exactly as written', () => {
    useFixture('basic.json');
    expect(readDeniedMcpTools(file)).toEqual(new Set(['mcp__github__search']));
  });
  it('throws on broken JSON', () => {
    useFixture('broken.json');
    expect(() => readDeniedMcpTools(file)).toThrow();
  });
});

describe('denyMcpTool', () => {
  it('adds the rule to the deny array and preserves the other keys', () => {
    useFixture('basic.json');
    denyMcpTool(file, 'notion', 'notion-search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny).toContain('mcp__notion__notion-search');
    expect(after.permissions.deny).toContain('Read(.env)');   // non-mcp entries preserved
    expect(after.permissions.allow).toEqual(['Bash(npm run *)']); // sibling keys preserved
    expect(after.model).toBe('opus');                          // root keys preserved
  });
  it('is a no-op when it is already present (idempotent)', () => {
    useFixture('basic.json');
    denyMcpTool(file, 'github', 'search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny.filter((r: string) => r === 'mcp__github__search')).toHaveLength(1);
  });
  it('creates the file when it is missing', () => {
    denyMcpTool(file, 'github', 'search');
    expect(readDeniedMcpTools(file)).toEqual(new Set(['mcp__github__search']));
  });
  it('creates the permissions key when it is absent, then adds', () => {
    useFixture('no-permissions.json');
    denyMcpTool(file, 'github', 'search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny).toEqual(['mcp__github__search']);
    expect(after.model).toBe('opus');
  });
  it('leaves a .mcplens.bak backup before writing', () => {
    useFixture('basic.json');
    const before = fs.readFileSync(file, 'utf8');
    denyMcpTool(file, 'notion', 'notion-search');
    expect(fs.readFileSync(`${file}.mcplens.bak`, 'utf8')).toBe(before);
  });
  it('throws on broken JSON and leaves the file untouched', () => {
    useFixture('broken.json');
    const before = fs.readFileSync(file, 'utf8');
    expect(() => denyMcpTool(file, 'github', 'search')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('allowMcpTool', () => {
  it('removes only that rule and preserves the rest of deny', () => {
    useFixture('basic.json');
    allowMcpTool(file, 'github', 'search');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.permissions.deny).toEqual(['Read(.env)']);
  });
  it('is a no-op when the rule is absent: it does not even write the file (no backup)', () => {
    useFixture('basic.json');
    allowMcpTool(file, 'linear', 'create_issue');
    expect(fs.existsSync(`${file}.mcplens.bak`)).toBe(false);
  });
  it('is a no-op when the file is missing', () => {
    expect(() => allowMcpTool(file, 'github', 'search')).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
