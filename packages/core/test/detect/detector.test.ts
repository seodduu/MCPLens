import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClientId } from '../../src/types.js';
import { detectClients } from '../../src/detect/detector.js';

function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mcplens-detect-'));
}

function makeFile(filePath: string, mtime: Date) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '{}');
  utimesSync(filePath, mtime, mtime);
}

const NOW = new Date('2026-07-19T00:00:00Z');

describe('detectClients', () => {
  it('reports installed:false and activeWithinDays:null when the log root does not exist', () => {
    const missingRoot = path.join(scratchDir(), 'does-not-exist');
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [missingRoot]],
      ['codex', [missingRoot]],
      ['gemini-cli', [missingRoot]],
    ]);
    const result = detectClients(NOW, roots);
    const claude = result.find((r) => r.client === 'claude-code')!;
    expect(claude.installed).toBe(false);
    expect(claude.activeWithinDays).toBeNull();
  });

  it('computes the elapsed days against now when it is installed with a recent file', () => {
    const root = scratchDir();
    const recent = new Date('2026-07-17T00:00:00Z'); // 2 days before NOW
    makeFile(path.join(root, 'session.jsonl'), recent);
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [root]],
      ['codex', [path.join(scratchDir(), 'missing')]],
      ['gemini-cli', [path.join(scratchDir(), 'missing')]],
    ]);
    const result = detectClients(NOW, roots);
    const claude = result.find((r) => r.client === 'claude-code')!;
    expect(claude.installed).toBe(true);
    expect(claude.activeWithinDays).toBe(2);
  });

  it('reports activeWithinDays null when it is installed but has no .jsonl file', () => {
    const root = scratchDir();
    // create a non-jsonl file only
    makeFile(path.join(root, 'notes.txt'), NOW);
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [root]],
      ['codex', [path.join(scratchDir(), 'missing')]],
      ['gemini-cli', [path.join(scratchDir(), 'missing')]],
    ]);
    const result = detectClients(NOW, roots);
    const claude = result.find((r) => r.client === 'claude-code')!;
    expect(claude.installed).toBe(true);
    expect(claude.activeWithinDays).toBeNull();
  });

  it('finds .jsonl files inside nested directories too (walk depth)', () => {
    const root = scratchDir();
    const nested = new Date('2026-07-10T00:00:00Z'); // 9 days before NOW
    makeFile(path.join(root, 'a', 'b', 'c', 'deep.jsonl'), nested);
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [root]],
      ['codex', [path.join(scratchDir(), 'missing')]],
      ['gemini-cli', [path.join(scratchDir(), 'missing')]],
    ]);
    const result = detectClients(NOW, roots);
    const claude = result.find((r) => r.client === 'claude-code')!;
    expect(claude.installed).toBe(true);
    expect(claude.activeWithinDays).toBe(9);
  });

  it('includes all three clients in the result', () => {
    const missingRoot = path.join(scratchDir(), 'does-not-exist');
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [missingRoot]],
      ['codex', [missingRoot]],
      ['gemini-cli', [missingRoot]],
    ]);
    const result = detectClients(NOW, roots);
    const ids = result.map((r) => r.client).sort();
    expect(ids).toEqual(['claude-code', 'codex', 'gemini-cli']);
  });

  it('uses the newest mtime across .jsonl and .json files', () => {
    const root = scratchDir();
    makeFile(path.join(root, 'old.jsonl'), new Date('2026-07-01T00:00:00Z')); // 18 days
    makeFile(path.join(root, 'new.jsonl'), new Date('2026-07-18T00:00:00Z')); // 1 day
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [root]],
      ['codex', [path.join(scratchDir(), 'missing')]],
      ['gemini-cli', [path.join(scratchDir(), 'missing')]],
    ]);
    const result = detectClients(NOW, roots);
    const claude = result.find((r) => r.client === 'claude-code')!;
    expect(claude.activeWithinDays).toBe(1);
  });

  it('keeps detecting from the remaining files even with a missing or broken file (a dangling symlink)', () => {
    const root = scratchDir();
    makeFile(path.join(root, 'valid.jsonl'), new Date('2026-07-17T00:00:00Z')); // 2 days before NOW
    // A broken symlink pointing at a nonexistent target, causing ENOENT on statSync
    symlinkSync(path.join(root, 'does-not-exist.jsonl'), path.join(root, 'broken.jsonl'));
    const roots = new Map<ClientId, string[]>([
      ['claude-code', [root]],
      ['codex', [path.join(scratchDir(), 'missing')]],
      ['gemini-cli', [path.join(scratchDir(), 'missing')]],
    ]);
    const result = detectClients(NOW, roots);
    const claude = result.find((r) => r.client === 'claude-code')!;
    expect(claude.installed).toBe(true);
    expect(claude.activeWithinDays).toBe(2); // the broken symlink is ignored and the healthy file decides
  });
});
