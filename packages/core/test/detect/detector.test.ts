import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
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
  it('로그 루트가 존재하지 않는 클라이언트는 installed:false, activeWithinDays:null', () => {
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

  it('설치되어 있고 최근 파일이 있으면 now 기준 경과일수를 계산한다', () => {
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

  it('설치되어 있지만 .jsonl 파일이 없으면 activeWithinDays는 null', () => {
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

  it('중첩 디렉토리 안의 .jsonl 파일도 탐색한다 (walk depth)', () => {
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

  it('결과에 3개 클라이언트가 모두 포함된다', () => {
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

  it('.jsonl과 .json 파일 중 가장 최신 mtime을 사용한다', () => {
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
});
