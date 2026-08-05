// packages/cli/src/scan-run.ts
import { type LensStore, type McpServerSpec, type ServerIdentity, scanServer } from '@mcp-lens/core';
import { scanFailureLine } from './scan-report.js';
import { classifyScanFailure } from './scan-status.js';

/** Result of scanning one server: just enough for the caller to keep its console output format. */
export type ScanOneResult =
  | { ok: true; toolCount: number; totalTokens: number }
  | { ok: false; line: string };

/**
 * The per-server unit of the `mcp-lens scan` loop, extracted as a pure function.
 * It always records the outcome through recordServerScanStatus, success or failure, and never
 * throws to the caller, so one server's failure cannot wipe out the other servers' records and
 * the final store.save() in the for loop.
 * scan is a parameter so tests can inject failures (it defaults to the real scanServer).
 */
export async function scanOneServer(
  store: LensStore,
  spec: McpServerSpec,
  scannedAt: string,
  identities: ServerIdentity[],
  scan: typeof scanServer = scanServer,
): Promise<ScanOneResult> {
  try {
    const result = await scan(spec);
    store.upsertScanResult(
      result.definitions,
      result.bodies,
      identities.filter((identity) => identity.serverName === spec.name),
    );
    store.recordServerScanStatus(spec.name, 'ok', scannedAt);
    const totalTokens = result.definitions.reduce((n, d) => n + d.definitionTokens, 0);
    return { ok: true, toolCount: result.definitions.length, totalTokens };
  } catch (e) {
    const record = classifyScanFailure(e);
    store.recordServerScanStatus(spec.name, record.status, scannedAt, record.errorCode);
    return { ok: false, line: scanFailureLine(spec.name, e) };
  }
}
