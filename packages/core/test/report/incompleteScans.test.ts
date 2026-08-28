// Scan health on the report surface. Regression guard for the day-03 pilot finding: chakra-ui
// advertised 13 tools, its scan failed with "Session expired", and the report showed 2 rows built
// from call history alone with nothing saying the count was partial.
import { describe, it, expect } from 'vitest';
import { incompleteScans, incompleteScanLines } from '../../src/report/incompleteScans.js';
import { renderReport } from '../../src/report/markdown.js';
import type { ReportModel } from '../../src/report/model.js';
import type { ServerScanStatus } from '../../src/store/store.js';

const statuses = (
  entries: Record<string, ServerScanStatus>,
): ReadonlyMap<string, ServerScanStatus> => new Map(Object.entries(entries));

const EMPTY_MODEL: ReportModel = {
  generatedAt: '2026-08-28T00:00:00.000Z',
  days: 7,
  clients: [],
  totals: {
    actPerSessionTokens: 0, candidatePerSessionTokens: 0,
    actSavingTokens: 0, candidateSavingTokens: 0,
    actServerCount: 0, actToolCount: 0,
    candidateServerCount: 0, candidateToolCount: 0,
    inspectToolCount: 0, inspectWastedTokens: 0,
    healthyToolCount: 0, healthyResponseTokens: 0,
  },
  conflictedServers: [],
};

describe('names a server whose scan failed instead of showing a silent partial count', () => {
  it('lists the failed server with its error code', () => {
    const scans = incompleteScans(statuses({
      chakra: { status: 'failed', scannedAt: '2026-08-28T01:00:00.000Z', errorCode: 'Session expired' },
    }));
    expect(scans).toEqual([{
      serverName: 'chakra', status: 'failed',
      errorCode: 'Session expired', scannedAt: '2026-08-28T01:00:00.000Z',
    }]);
  });

  it('says the numbers are a lower bound, not that the server is cheap', () => {
    const [line] = incompleteScanLines(incompleteScans(statuses({
      chakra: { status: 'failed', scannedAt: '2026-08-28T01:00:00.000Z' },
    })));
    expect(line).toContain('chakra: scan failed');
    expect(line).toContain('lower bound');
  });

  it('renders the warning into the report before the tables', () => {
    const out = renderReport(
      { ...EMPTY_MODEL, incompleteServers: incompleteScans(statuses({
        chakra: { status: 'failed', scannedAt: '2026-08-28T01:00:00.000Z' },
      })) },
      { days: 7 },
    );
    expect(out).toContain('chakra: scan failed');
  });

  it('separates authentication from failure so the fix differs', () => {
    const [line] = incompleteScanLines(incompleteScans(statuses({
      figma: { status: 'auth-required', scannedAt: '2026-08-28T01:00:00.000Z' },
    })));
    expect(line).toContain('authentication required');
  });
});

describe('keeps the existing output for servers scanned ok', () => {
  it('reports nothing when every scan succeeded', () => {
    expect(incompleteScans(statuses({
      deepwiki: { status: 'ok', scannedAt: '2026-08-28T01:00:00.000Z' },
    }))).toEqual([]);
  });

  it('reports nothing when the caller passes no statuses at all', () => {
    expect(incompleteScans(undefined)).toEqual([]);
  });

  it('leaves the rendered report unchanged when there is nothing incomplete', () => {
    const withEmpty = renderReport({ ...EMPTY_MODEL, incompleteServers: [] }, { days: 7 });
    const withNone = renderReport(EMPTY_MODEL, { days: 7 });
    expect(withEmpty).toEqual(withNone);
  });
});

describe('orders incomplete servers so the output is stable', () => {
  it('sorts by server name regardless of map order', () => {
    const scans = incompleteScans(statuses({
      zulu: { status: 'failed', scannedAt: '2026-08-28T01:00:00.000Z' },
      alpha: { status: 'auth-required', scannedAt: '2026-08-28T01:00:00.000Z' },
    }));
    expect(scans.map((s) => s.serverName)).toEqual(['alpha', 'zulu']);
  });
});
