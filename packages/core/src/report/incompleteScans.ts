// packages/core/src/report/incompleteScans.ts
// Which servers the report is only partly able to account for.
//
// A server whose scan failed still shows up in the report: rows are joined from call history, so
// the tools that happened to be called appear and the rest do not exist as far as the report is
// concerned. Nothing on the surface says so, and the reader takes the row count and the token
// total as the whole truth. Measured on the day-03 pilot batch: chakra-ui advertised 13 tools, its
// scan failed with "Session expired", and the report showed 2 rows built from calls alone.
//
// The waste totals of such a server are a lower bound, never the full picture, and saying that out
// loud is the difference between "this server is cheap" and "we could not measure this server".

import type { ServerScanStatus, ServerScanStatusKind } from '../store/store.js';

export interface IncompleteScan {
  serverName: string;
  status: Exclude<ServerScanStatusKind, 'ok'>;
  /** The scanner's error code when it recorded one. null otherwise. */
  errorCode: string | null;
  scannedAt: string;
}

/**
 * Servers whose last scan did not complete, sorted by name so the output is stable.
 * A server missing from the map has never been scanned at all, which this function cannot see;
 * that case is a different signal (never attempted) and belongs to the caller.
 */
export function incompleteScans(
  statuses: ReadonlyMap<string, ServerScanStatus> | undefined,
): IncompleteScan[] {
  if (!statuses) return [];
  const out: IncompleteScan[] = [];
  for (const [serverName, s] of statuses) {
    if (s.status === 'ok') continue;
    out.push({
      serverName,
      status: s.status,
      errorCode: s.errorCode ?? null,
      scannedAt: s.scannedAt,
    });
  }
  return out.sort((a, b) => a.serverName.localeCompare(b.serverName));
}

/** One line per server, for renderers that have no structure to put this in. */
export function incompleteScanLines(scans: readonly IncompleteScan[]): string[] {
  return scans.map((s) => {
    const why = s.status === 'auth-required' ? 'authentication required' : 'scan failed';
    const code = s.errorCode ? ` (${s.errorCode})` : '';
    return `${s.serverName}: ${why}${code}. Its tool definitions are unmeasured, `
      + 'so the numbers below are a lower bound';
  });
}
