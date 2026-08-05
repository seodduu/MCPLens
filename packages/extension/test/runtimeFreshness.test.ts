import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { memFsStub } from './helpers/memFs.js';
import {
  bundledStamp,
  installedStamp,
  needsRuntimeRefresh,
  recordInstalledStamp,
  stampRecordPath,
} from '../src/runtimeFreshness.js';

const HOME = '/home/u';
const BUNDLE = '/ext/dist/claude-marketplace';
const STAMP_FILE = join(BUNDLE, 'mcp-lens', 'runtime', 'runtime-stamp.json');

describe('bundledStamp', () => {
  it('reads the fingerprint of the bundled runtime', () => {
    const fs = memFsStub({ [STAMP_FILE]: JSON.stringify({ stamp: 'abc123' }) });
    expect(bundledStamp(fs, BUNDLE, 'claude-code')).toBe('abc123');
  });

  it('returns null when the file is missing: undecidable, not an error', () => {
    expect(bundledStamp(memFsStub(), BUNDLE, 'claude-code')).toBeNull();
  });

  it('returns null instead of throwing on broken JSON', () => {
    const fs = memFsStub({ [STAMP_FILE]: '{ not json' });
    expect(bundledStamp(fs, BUNDLE, 'claude-code')).toBeNull();
  });
});

describe('installedStamp / recordInstalledStamp', () => {
  it('reads back the fingerprint recorded at install time, per client', () => {
    const fs = memFsStub();
    recordInstalledStamp(fs, HOME, 'claude-code', 'abc123');
    recordInstalledStamp(fs, HOME, 'codex', 'def456');

    expect(installedStamp(fs, HOME, 'claude-code')).toBe('abc123');
    expect(installedStamp(fs, HOME, 'codex')).toBe('def456');
    expect(installedStamp(fs, HOME, 'gemini-cli')).toBeNull();
  });

  it('preserves other clients records when one client is updated', () => {
    const fs = memFsStub();
    recordInstalledStamp(fs, HOME, 'claude-code', 'old');
    recordInstalledStamp(fs, HOME, 'codex', 'keep');
    recordInstalledStamp(fs, HOME, 'claude-code', 'new');

    expect(installedStamp(fs, HOME, 'claude-code')).toBe('new');
    expect(installedStamp(fs, HOME, 'codex')).toBe('keep');
  });

  it('rewrites the record file instead of throwing when it is broken', () => {
    const fs = memFsStub({ [stampRecordPath(HOME)]: 'garbage' });
    recordInstalledStamp(fs, HOME, 'codex', 'x');
    expect(installedStamp(fs, HOME, 'codex')).toBe('x');
  });

  it('does not propagate an exception when the write fails (it must not block the install)', () => {
    const fs = { ...memFsStub(), writeFile: () => { throw new Error('EACCES'); } };
    expect(() => recordInstalledStamp(fs, HOME, 'codex', 'x')).not.toThrow();
  });
});

describe('needsRuntimeRefresh', () => {
  it('needs an update when it is installed and the fingerprint differs', () => {
    expect(needsRuntimeRefresh('installed', 'bundled-1', 'installed-0')).toBe(true);
  });

  it('needs no update when the fingerprint matches', () => {
    expect(needsRuntimeRefresh('installed', 'same', 'same')).toBe(false);
  });

  // The real path of this incident: a user who installed with a version that had no fingerprint concept.
  it('needs an update when there is no install record (installed by an older version)', () => {
    expect(needsRuntimeRefresh('installed', 'bundled-1', null)).toBe(true);
  });

  it('is not an update target when no hook is installed', () => {
    expect(needsRuntimeRefresh('not-installed', 'bundled-1', null)).toBe(false);
    expect(needsRuntimeRefresh('client-missing', 'bundled-1', null)).toBe(false);
  });

  // With an unreadable bundle fingerprint there is no basis for comparison. Reinstalling blindly could
  // reinstall on every startup, so nothing is done.
  it('does not update when the bundle fingerprint cannot be read', () => {
    expect(needsRuntimeRefresh('installed', null, null)).toBe(false);
    expect(needsRuntimeRefresh('installed', null, 'installed-0')).toBe(false);
  });
});
