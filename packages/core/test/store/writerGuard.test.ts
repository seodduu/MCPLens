import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LensStore, StaleWriterError } from '../../src/store/store.js';

const DEF = (tool: string) => ({ serverName: 's', toolName: tool, definitionTokens: 1,
  scannedAt: '2026-07-22T00:00:00Z', firstScannedAt: '2026-07-22T00:00:00Z' });

let dir: string; let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guard-')); file = join(dir, 'lens.db'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeGuard', () => {
  it('makes save throw StaleWriterError when the guard is false', async () => {
    const s = await LensStore.open(file);
    s.setWriteGuard(() => false);
    expect(() => s.upsertDefinitions([DEF('a')])).toThrow(StaleWriterError);
  });

  it('saves normally when the guard is true', async () => {
    const s = await LensStore.open(file);
    s.setWriteGuard(() => true);
    expect(() => s.upsertDefinitions([DEF('a')])).not.toThrow();
  });

  it('picks up externally changed file content on reload', async () => {
    const writer = await LensStore.open(file);
    writer.upsertDefinitions([DEF('a')]);           // writes a to the file
    const reader = await LensStore.open(file);       // has read a
    writer.upsertDefinitions([DEF('a'), DEF('b')]);  // the external writer adds b
    reader.reload();                                 // re-read from disk
    // the reader now sees b (checked through the definitions query API)
    const names = reader.allDefinitions().map((d) => d.toolName).sort();
    expect(names).toEqual(['a', 'b']);
  });
});
