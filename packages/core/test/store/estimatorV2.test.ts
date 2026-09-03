import { afterEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LensStore } from '../../src/store/store.js';
import type { ServerContextOverhead, ToolDefinition } from '../../src/types.js';

const NOW = '2026-08-27T00:00:00.000Z';
const temporaryRoots: string[] = [];

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcplens-estimator-v2-'));
  temporaryRoots.push(root);
  return join(root, 'lens.db');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Writes a database whose tool_definitions table predates advertised_tokens and
 * estimator_version (but already has first_scanned_at, i.e. it is a "v1" row).
 */
async function writeLegacyDatabase(path: string): Promise<void> {
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE tool_definitions (
      server_name       TEXT NOT NULL,
      tool_name         TEXT NOT NULL,
      definition_tokens INTEGER NOT NULL,
      scanned_at        TEXT NOT NULL,
      first_scanned_at  TEXT,
      PRIMARY KEY (server_name, tool_name)
    );
    INSERT INTO tool_definitions VALUES('github','get_issue',120,'${NOW}','${NOW}');`);
  writeFileSync(path, Buffer.from(legacy.export()));
  legacy.close();
}

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    serverName: 'github', toolName: 'get_issue', definitionTokens: 193,
    advertisedTokens: 120, nameListTokens: null, estimatorVersion: 'v2-2026-08-27',
    scannedAt: NOW, firstScannedAt: NOW,
    ...overrides,
  };
}

function overhead(overrides: Partial<ServerContextOverhead> = {}): ServerContextOverhead {
  return {
    serverName: 'deepwiki', instructionsTokens: 930, instructionsSha256: 'abc123',
    estimatorVersion: 'v2-2026-08-27', scannedAt: NOW,
    ...overrides,
  };
}

describe('estimator v2 store contract', () => {
  it('round-trips advertisedTokens and estimatorVersion', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertDefinitions([definition()]);

    const [row] = store.allDefinitions();
    expect(row.advertisedTokens).toBe(120);
    expect(row.estimatorVersion).toBe('v2-2026-08-27');
    store.close();
  });

  it('reads a pre-migration row as estimator version v1', async () => {
    const path = temporaryDatabase();
    await writeLegacyDatabase(path);

    const store = await LensStore.open(path);
    const [row] = store.allDefinitions();
    expect(row.estimatorVersion).toBe('v1');
    expect(row.advertisedTokens).toBeNull();
    store.close();
  });

  it('reads a pre-migration row with nameListTokens null', async () => {
    const path = temporaryDatabase();
    await writeLegacyDatabase(path);

    const store = await LensStore.open(path);
    expect(store.allDefinitions()[0].nameListTokens).toBeNull();
    store.close();
  });

  it('round-trips a server context overhead', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertServerContextOverheads([overhead()]);

    expect(store.allServerContextOverheads()).toEqual([overhead()]);
    store.close();
  });

  it('overwrites a server context overhead on rescan', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertServerContextOverheads([overhead({ instructionsTokens: 930, scannedAt: NOW })]);
    store.upsertServerContextOverheads([overhead({
      instructionsTokens: 1024, instructionsSha256: 'def456', scannedAt: '2026-08-28T00:00:00.000Z',
    })]);

    const rows = store.allServerContextOverheads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(overhead({
      instructionsTokens: 1024, instructionsSha256: 'def456', scannedAt: '2026-08-28T00:00:00.000Z',
    }));
    store.close();
  });

  // T4: the scan-result write path (store.upsertScanResult, called from cli/extension after a
  // scan) must also persist the overhead it receives, not just the standalone
  // upsertServerContextOverheads setter exercised above.
  it('persists a server context overhead passed through upsertScanResult', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertScanResult([definition()], [], [], overhead());

    expect(store.allServerContextOverheads()).toEqual([overhead()]);
    store.close();
  });

  it('upsertScanResult with no overhead argument leaves overheads untouched', async () => {
    const store = await LensStore.open(':memory:');
    store.upsertScanResult([definition()], [], []);

    expect(store.allServerContextOverheads()).toEqual([]);
    store.close();
  });
});
