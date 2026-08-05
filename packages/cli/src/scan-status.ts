// packages/cli/src/scan-status.ts
export interface ScanStatusRecord {
  status: 'ok' | 'auth-required' | 'failed';
  errorCode?: string;
}

/**
 * Classifies a scan exception into a server_scan_status value.
 * Kept identical to the rule in packages/extension/src/autoScan.ts:
 * auth-required/token-expired messages become auth-required (no errorCode),
 * everything else becomes failed (errorCode truncated to 120 characters).
 * err is typed unknown: scanServer rethrows SDK exceptions verbatim, so a non-Error value
 * (a string, say) can arrive, and asserting Error to read err.message would throw a TypeError
 * inside the catch block, never reaching store.save() and losing that run's records.
 */
export function classifyScanFailure(err: unknown): ScanStatusRecord {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth-required') || msg.includes('token-expired')) {
    return { status: 'auth-required' };
  }
  return { status: 'failed', errorCode: msg.slice(0, 120) };
}
