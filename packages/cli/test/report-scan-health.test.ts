// The CLI report has to say when a server's scan did not complete: its rows come from call
// history alone, so its totals understate it (day-03 pilot: chakra-ui, 13 tools, 2 rows shown).
import { describe, it, expect } from 'vitest';
import type { IncompleteScan, MatrixRow } from '@mcp-lens/core';
import { formatReport } from '../src/report.js';

const SAVINGS = { potentialTokens: 0, actualTokens: 0, savedTokens: 0, savedRatio: 0 } as never;
const ROWS: MatrixRow[] = [];
const INCOMPLETE: IncompleteScan[] = [{
  serverName: 'chakra', status: 'failed', errorCode: 'Session expired',
  scannedAt: '2026-08-28T01:00:00.000Z',
}];

describe('CLI report surfaces an incomplete scan', () => {
  it('warns above the table', () => {
    const out = formatReport(ROWS, SAVINGS, 'table', INCOMPLETE);
    expect(out).toContain('chakra: scan failed (Session expired)');
    expect(out.indexOf('chakra')).toBeLessThan(out.length);
  });

  it('warns in the ai format too', () => {
    expect(formatReport(ROWS, SAVINGS, 'ai', INCOMPLETE)).toContain('chakra: scan failed');
  });

  it('always carries the key in json, empty array included', () => {
    const clean = JSON.parse(formatReport(ROWS, SAVINGS, 'json', []));
    expect(clean.incompleteServers).toEqual([]);
    const dirty = JSON.parse(formatReport(ROWS, SAVINGS, 'json', INCOMPLETE));
    expect(dirty.incompleteServers[0].serverName).toEqual('chakra');
  });

  it('is unchanged when every scan is ok', () => {
    expect(formatReport(ROWS, SAVINGS, 'table', [])).toEqual(formatReport(ROWS, SAVINGS, 'table'));
  });
});
