import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCodexDisabledTool, restoreCodexDisabledTool } from '../../src/actions/codex.js';
import type { ActionFileSystem } from '../../src/actions/claude.js';
import type { GlobalAction } from '../../src/types.js';

const fixtures = join(__dirname, '..', '..', '..', '..', 'fixtures', 'actions', 'codex');
const settingsPath = '/home/test/.codex/config.toml';
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

class MemFs implements ActionFileSystem {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  onFsync?: (file: string) => void;
  constructor(value: string) { this.files.set(settingsPath, value); }
  async readFile(file: string) { const value = this.files.get(file); if (value === undefined) throw new Error(`ENOENT: ${file}`); return value; }
  async writeFile(file: string, value: string) { this.calls.push(`write:${file}`); this.files.set(file, value); }
  async copyFile(from: string, to: string) { this.calls.push(`copy:${from}:${to}`); this.files.set(to, await this.readFile(from)); }
  async rename(from: string, to: string) { this.calls.push(`rename:${from}:${to}`); this.files.set(to, await this.readFile(from)); this.files.delete(from); }
  async mkdir(directory: string) { this.calls.push(`mkdir:${directory}`); }
  async fsync(file: string) { this.calls.push(`fsync:${file}`); this.onFsync?.(file); }
  async remove(file: string) { this.calls.push(`remove:${file}`); this.files.delete(file); }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  serverName: 'github', toolName: 'search', settingsPath, now: new Date('2026-08-03T12:00:00.000Z'), ...overrides,
});

const actionFrom = (result: { backupPath?: string; preFingerprint?: string; postFingerprint?: string }): GlobalAction => ({
  actionId: 'action-1', client: 'codex', serverName: 'github', toolName: 'search', identityHash: 'identity', definitionSetHash: 'definition', ownedRule: 'search', backupPath: result.backupPath!, preFingerprint: result.preFingerprint!, postFingerprint: result.postFingerprint!, status: 'active', createdAt: '2026-08-03T12:00:00.000Z', restoredAt: null,
});

describe('Codex disabled_tools action', () => {
  it('backs up, fingerprints, atomically appends an unprefixed tool name, and preserves the rest of config', async () => {
    const fs = new MemFs(fixture('clean.toml'));
    const before = await fs.readFile(settingsPath);

    const result = await applyCodexDisabledTool(request(), fs);

    expect(result.status).toBe('applied');
    expect(result.rule).toBe('search');
    expect(result.preFingerprint).toBe(createHash('sha256').update(before).digest('hex'));
    expect(await fs.readFile(result.backupPath!)).toBe(before);
    expect(await fs.readFile(settingsPath)).toBe('[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\ndisabled_tools = ["search"]\n');
    expect(fs.calls.some((call) => call.startsWith('fsync:'))).toBe(true);
    expect(fs.calls.some((call) => call.startsWith('rename:'))).toBe(true);
  });

  it('does not write identity conflicts, malformed TOML, absent servers, or user-owned disabled tools', async () => {
    for (const [value, overrides] of [
      ['[mcp_servers.github\ncommand = "npx"\n', {}],
      [fixture('clean.toml'), { identityConflict: true }],
      ['[mcp_servers.other]\ncommand = "npx"\n', {}],
      [fixture('existing-disabled.toml'), {}],
    ] as const) {
      const fs = new MemFs(value);
      const result = await applyCodexDisabledTool(request(overrides), fs);
      expect(result.status).not.toBe('applied');
      expect(await fs.readFile(settingsPath)).toBe(value);
      expect(fs.calls.filter((call) => call.startsWith('copy:') || call.startsWith('rename:'))).toHaveLength(0);
    }
  });

  it('restores only the owned tool when the recorded post-state still matches', async () => {
    const fs = new MemFs(fixture('clean.toml'));
    const applied = await applyCodexDisabledTool(request(), fs);

    const result = await restoreCodexDisabledTool(actionFrom(applied), fs);

    expect(result.status).toBe('restored');
    expect(await fs.readFile(settingsPath)).toBe(fixture('clean.toml'));
  });

  it('leaves user edits untouched when restoring a changed post-state', async () => {
    const fs = new MemFs(fixture('clean.toml'));
    const applied = await applyCodexDisabledTool(request(), fs);
    await fs.writeFile(settingsPath, '[mcp_servers.github]\ncommand = "changed"\ndisabled_tools = ["search"]\n');
    const before = await fs.readFile(settingsPath);

    const result = await restoreCodexDisabledTool(actionFrom(applied), fs);

    expect(result).toMatchObject({ status: 'conflict', backupPath: applied.backupPath });
    expect(await fs.readFile(settingsPath)).toBe(before);
  });

  it('does not replace a config changed after the snapshot and cleans its temporary file', async () => {
    const fs = new MemFs(fixture('clean.toml'));
    const userEdit = '[mcp_servers.github]\ncommand = "user-edit"\n';
    fs.onFsync = (file) => { if (file.includes('.mcplens.tmp')) fs.files.set(settingsPath, userEdit); };

    const result = await applyCodexDisabledTool(request(), fs);

    expect(result.status).toBe('failed');
    expect(await fs.readFile(settingsPath)).toBe(userEdit);
    expect([...fs.files.keys()].some((file) => file.includes('.mcplens.tmp-'))).toBe(false);
  });

  it('serializes concurrent actions and uses distinct backups at the same timestamp', async () => {
    const fs = new MemFs(fixture('clean.toml'));

    const [first, second] = await Promise.all([
      applyCodexDisabledTool(request({ toolName: 'search' }), fs),
      applyCodexDisabledTool(request({ toolName: 'issues' }), fs),
    ]);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(await fs.readFile(first.backupPath!)).toBe(fixture('clean.toml'));
  });

  it('reports a restore conflict rather than overwriting an edit made before rename', async () => {
    const fs = new MemFs(fixture('clean.toml'));
    const applied = await applyCodexDisabledTool(request(), fs);
    const userEdit = '[mcp_servers.github]\ncommand = "user-edit"\ndisabled_tools = ["search"]\n';
    fs.onFsync = (file) => { if (file.includes('.mcplens.tmp')) fs.files.set(settingsPath, userEdit); };

    const result = await restoreCodexDisabledTool(actionFrom(applied), fs);

    expect(result.status).toBe('conflict');
    expect(await fs.readFile(settingsPath)).toBe(userEdit);
    expect([...fs.files.keys()].some((file) => file.includes('.mcplens.tmp-'))).toBe(false);
  });
});
