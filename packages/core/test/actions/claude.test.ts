import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyClaudeGlobalDeny,
  restoreClaudeGlobalDeny,
  type ActionFileSystem,
} from '../../src/actions/claude.js';
import type { GlobalAction } from '../../src/types.js';

const fixtures = join(__dirname, '..', '..', '..', '..', 'fixtures', 'actions', 'claude');
const settingsPath = '/home/test/.claude/settings.json';

class MemFs implements ActionFileSystem {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  onFsync?: (file: string) => void;
  constructor(value?: string) { if (value !== undefined) this.files.set(settingsPath, value); }
  async readFile(file: string) { const value = this.files.get(file); if (value === undefined) throw new Error(`ENOENT: ${file}`); return value; }
  async writeFile(file: string, value: string) { this.calls.push(`write:${file}`); this.files.set(file, value); }
  async copyFile(from: string, to: string) { this.calls.push(`copy:${from}:${to}`); this.files.set(to, await this.readFile(from)); }
  async rename(from: string, to: string) { this.calls.push(`rename:${from}:${to}`); this.files.set(to, await this.readFile(from)); this.files.delete(from); }
  async mkdir(directory: string) { this.calls.push(`mkdir:${directory}`); }
  async fsync(file: string) { this.calls.push(`fsync:${file}`); this.onFsync?.(file); }
  async listFiles(directory: string) { return [...this.files.keys()].filter((file) => file.startsWith(`${directory}/`)); }
  async remove(file: string) { this.calls.push(`remove:${file}`); this.files.delete(file); }
}

const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const request = (overrides: Record<string, unknown> = {}) => ({
  serverName: 'github', toolName: 'search', settingsPath, now: new Date('2026-08-03T12:00:00.000Z'), ...overrides,
});

describe('applyClaudeGlobalDeny', () => {
  it('backs up, fingerprints, fsyncs, and atomically appends exactly one owned deny rule', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const before = await fs.readFile(settingsPath);

    const result = await applyClaudeGlobalDeny(request(), fs);

    expect(result.status).toBe('applied');
    expect(result.preFingerprint).toBe(createHash('sha256').update(before).digest('hex'));
    expect(result.postFingerprint).toBe(createHash('sha256').update(await fs.readFile(settingsPath)).digest('hex'));
    expect(result.backupPath).toBeDefined();
    expect(await fs.readFile(result.backupPath!)).toBe(before);
    expect(JSON.parse(await fs.readFile(settingsPath))).toEqual({ permissions: { deny: ['Read(.env)', 'mcp__github__search'] }, model: 'haiku' });
    expect(fs.calls.some((call) => call.startsWith('fsync:'))).toBe(true);
    expect(fs.calls.some((call) => call.startsWith('rename:'))).toBe(true);
  });

  it('does not write malformed settings, identity conflicts, or an existing user-owned rule', async () => {
    for (const [value, overrides] of [
      [fixture('commented-broken.json'), {}],
      [fixture('clean.json'), { identityConflict: true }],
      [fixture('existing-deny.json'), {}],
    ] as const) {
      const fs = new MemFs(value);
      const result = await applyClaudeGlobalDeny(request(overrides), fs);
      expect(result.status).not.toBe('applied');
      expect(await fs.readFile(settingsPath)).toBe(value);
      expect(fs.calls.filter((call) => call.startsWith('copy:') || call.startsWith('rename:'))).toHaveLength(0);
    }
  });

  it('does not replace settings changed after the snapshot and cleans its temporary file', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const userEdit = '{"permissions":{"deny":["Read(.env)"]},"model":"opus"}\n';
    fs.onFsync = (file) => { if (file.includes('.mcplens.tmp-')) fs.files.set(settingsPath, userEdit); };

    const result = await applyClaudeGlobalDeny(request(), fs);

    expect(result.status).toBe('failed');
    expect(await fs.readFile(settingsPath)).toBe(userEdit);
    expect([...fs.files.keys()].some((file) => file.includes('.mcplens.tmp-'))).toBe(false);
  });

  it('serializes concurrent actions and uses distinct backups at the same timestamp', async () => {
    const fs = new MemFs(fixture('clean.json'));

    const [first, second] = await Promise.all([
      applyClaudeGlobalDeny(request({ toolName: 'search' }), fs),
      applyClaudeGlobalDeny(request({ toolName: 'issues' }), fs),
    ]);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(await fs.readFile(first.backupPath!)).toBe(fixture('clean.json'));
  });

  it('keeps backups referenced by protected Claude actions while pruning completed backups', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const backup = (stamp: string) => `${settingsPath}.mcplens-${stamp}.bak`;
    const activeBackup = backup('2026-07-01T00-00-00-000Z');
    const pendingBackup = backup('2026-07-02T00-00-00-000Z');
    const conflictBackup = backup('2026-07-03T00-00-00-000Z');
    for (const stamp of [
      '2026-07-01T00-00-00-000Z', '2026-07-02T00-00-00-000Z', '2026-07-03T00-00-00-000Z',
      '2026-07-04T00-00-00-000Z', '2026-07-05T00-00-00-000Z', '2026-07-06T00-00-00-000Z',
      '2026-07-07T00-00-00-000Z', '2026-07-08T00-00-00-000Z',
    ]) await fs.writeFile(backup(stamp), 'backup');
    const action = (overrides: Partial<GlobalAction>): GlobalAction => ({
      actionId: 'action', client: 'claude-code', serverName: 'github', toolName: 'search', identityHash: 'identity', definitionSetHash: 'definition', ownedRule: 'mcp__github__search', backupPath: activeBackup, preFingerprint: 'pre', postFingerprint: 'post', status: 'active', createdAt: '2026-08-03T00:00:00.000Z', restoredAt: null, ...overrides,
    });

    await applyClaudeGlobalDeny(request({ actions: [
      action({ backupPath: activeBackup, status: 'active' }),
      action({ backupPath: pendingBackup, status: 'restore-pending' }),
      action({ backupPath: conflictBackup, status: 'conflict' }),
      action({ client: 'codex', backupPath: backup('2026-07-04T00-00-00-000Z'), status: 'active' }),
      action({ backupPath: backup('2026-07-05T00-00-00-000Z'), status: 'restored' }),
    ] }), fs);

    expect(fs.files.has(activeBackup)).toBe(true);
    expect(fs.files.has(pendingBackup)).toBe(true);
    expect(fs.files.has(conflictBackup)).toBe(true);
    expect(fs.files.size).toBeLessThanOrEqual(6); // settings + the 5 most recent, or a protected backup
  });
});

describe('restoreClaudeGlobalDeny', () => {
  it('removes only the owned rule when the current file matches the recorded post-state', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const applied = await applyClaudeGlobalDeny(request(), fs);
    const action: GlobalAction = {
      actionId: 'action-1', client: 'claude-code', serverName: 'github', toolName: 'search', identityHash: 'identity', definitionSetHash: 'definition', ownedRule: 'mcp__github__search', backupPath: applied.backupPath!, preFingerprint: applied.preFingerprint!, postFingerprint: applied.postFingerprint!, status: 'active', createdAt: '2026-08-03T12:00:00.000Z', restoredAt: null,
    };

    const result = await restoreClaudeGlobalDeny(action, fs);

    expect(result.status).toBe('restored');
    expect(JSON.parse(await fs.readFile(settingsPath))).toEqual(JSON.parse(fixture('clean.json')));
  });

  it('stops with conflict and leaves user edits untouched', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const applied = await applyClaudeGlobalDeny(request(), fs);
    const action: GlobalAction = {
      actionId: 'action-1', client: 'claude-code', serverName: 'github', toolName: 'search', identityHash: 'identity', definitionSetHash: 'definition', ownedRule: 'mcp__github__search', backupPath: applied.backupPath!, preFingerprint: applied.preFingerprint!, postFingerprint: applied.postFingerprint!, status: 'active', createdAt: '2026-08-03T12:00:00.000Z', restoredAt: null,
    };
    await fs.writeFile(settingsPath, '{"permissions":{"deny":["Read(.env)","mcp__github__search"]},"model":"opus"}\n');
    const before = await fs.readFile(settingsPath);

    const result = await restoreClaudeGlobalDeny(action, fs);

    expect(result.status).toBe('conflict');
    expect(result.backupPath).toBe(action.backupPath);
    expect(await fs.readFile(settingsPath)).toBe(before);
  });

  it('reports a conflict rather than overwriting an edit made before restore rename', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const applied = await applyClaudeGlobalDeny(request(), fs);
    const action: GlobalAction = {
      actionId: 'action-1', client: 'claude-code', serverName: 'github', toolName: 'search', identityHash: 'identity', definitionSetHash: 'definition', ownedRule: 'mcp__github__search', backupPath: applied.backupPath!, preFingerprint: applied.preFingerprint!, postFingerprint: applied.postFingerprint!, status: 'active', createdAt: '2026-08-03T12:00:00.000Z', restoredAt: null,
    };
    const userEdit = '{"permissions":{"deny":["Read(.env)","mcp__github__search"]},"model":"opus"}\n';
    fs.onFsync = (file) => { if (file.includes('.mcplens.tmp-')) fs.files.set(settingsPath, userEdit); };

    const result = await restoreClaudeGlobalDeny(action, fs);

    expect(result.status).toBe('conflict');
    expect(await fs.readFile(settingsPath)).toBe(userEdit);
    expect([...fs.files.keys()].some((file) => file.includes('.mcplens.tmp-'))).toBe(false);
  });

  it('treats an unusable backup location as a restore conflict without writing', async () => {
    const fs = new MemFs(fixture('clean.json'));
    const before = await fs.readFile(settingsPath);
    const action: GlobalAction = {
      actionId: 'action-1', client: 'claude-code', serverName: 'github', toolName: 'search', identityHash: 'identity', definitionSetHash: 'definition', ownedRule: 'mcp__github__search', backupPath: '/invalid-backup.json', preFingerprint: 'before', postFingerprint: 'after', status: 'active', createdAt: '2026-08-03T12:00:00.000Z', restoredAt: null,
    };

    await expect(restoreClaudeGlobalDeny(action, fs)).resolves.toMatchObject({ status: 'conflict', backupPath: action.backupPath });
    expect(await fs.readFile(settingsPath)).toBe(before);
  });
});
