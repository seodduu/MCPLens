// packages/cli/src/scan-report.ts
/**
 * Per-server scan failure line. auth-required errors get their own guidance.
 * err is typed unknown: scanServer rethrows SDK exceptions verbatim, so a non-Error value can
 * arrive, and asserting err.message would kill the scan loop that calls this function, losing
 * every recordServerScanStatus write made before store.save()
 * (normalized the same way, and for the same reason, as classifyScanFailure).
 */
export function scanFailureLine(name: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth-required')) {
    return `- ${name}: authentication required, skipped (log in with npx mcp-lens auth ${name})`;
  }
  return `- ${name}: scan failed: ${msg}`;
}

/** Per-source discovery summary (e.g. "claude-user 2 · codex 1"). Sources with 0 finds are omitted. */
export function formatSourceCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(' · ');
}
