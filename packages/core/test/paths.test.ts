import { describe, it, expect } from 'vitest';
import { lensHome, dbPath, clientLogRoots, dbWriterLockPath } from '../src/paths.js';
import os from 'node:os';
import path from 'node:path';

describe('paths', () => {
  it('puts lensHome at .mcplens under home', () => {
    expect(lensHome()).toBe(path.join(os.homedir(), '.mcplens'));
  });
  it('names the database lens.db', () => {
    expect(dbPath()).toBe(path.join(os.homedir(), '.mcplens', 'lens.db'));
  });
  it('returns absolute client log roots with no hardcoded ~', () => {
    const roots = clientLogRoots('claude-code');
    expect(roots[0]).toBe(path.join(os.homedir(), '.claude', 'projects'));
    expect(roots.every((r) => path.isAbsolute(r))).toBe(true);
  });
});

describe('dbWriterLockPath', () => {
  it('puts the lock at .mcplens/db-writer.lock under home', () => {
    expect(dbWriterLockPath('/home/u')).toBe('/home/u/.mcplens/db-writer.lock');
  });
  it('falls back to os.homedir() without an argument', () => {
    expect(dbWriterLockPath()).toBe(path.join(os.homedir(), '.mcplens', 'db-writer.lock'));
  });
});
