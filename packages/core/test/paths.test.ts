import { describe, it, expect } from 'vitest';
import { lensHome, dbPath, clientLogRoots } from '../src/paths.js';
import os from 'node:os';
import path from 'node:path';

describe('paths', () => {
  it('lensHome은 홈 밑 .mcplens', () => {
    expect(lensHome()).toBe(path.join(os.homedir(), '.mcplens'));
  });
  it('dbPath는 lens.db', () => {
    expect(dbPath()).toBe(path.join(os.homedir(), '.mcplens', 'lens.db'));
  });
  it('클라이언트 로그 루트는 ~ 하드코딩 없이 절대경로', () => {
    const roots = clientLogRoots('claude-code');
    expect(roots[0]).toBe(path.join(os.homedir(), '.claude', 'projects'));
    expect(roots.every((r) => path.isAbsolute(r))).toBe(true);
  });
});
