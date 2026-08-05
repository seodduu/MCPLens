// packages/cli/src/auth-rescan.ts
import { type LensStore, type McpServerSpec, scanServer } from '@mcp-lens/core';
import { scanFailureLine } from './scan-report.js';
import { classifyScanFailure } from './scan-status.js';

/**
 * Rescans one server right after login and saves/closes the store either way.
 * scan is a parameter so tests can inject failures (it defaults to the real scanServer).
 * save/close live in a single finally so that whatever recordServerScanStatus wrote on both
 * branches (success and failure) lands on disk. That guarantee is why this function exists.
 *
 * Why it is split out of main.ts: main.ts unconditionally runs main() on its last line, so
 * merely importing it starts a CLI that opens the real DB. runAuthRescan is a side-effect-free
 * unit (tests inject scan), so keeping it in its own module makes it as safe to import and test
 * as the vscode-free core functions.
 *
 * It takes no separate name parameter and uses spec.name as the DB key: the caller
 * (main.ts runAuth) resolves the spec through resolveAuthTarget(specs, name), which returns
 * only a spec matching `s.name === name` exactly, so target.spec.name always equals the name
 * the user typed. The two values cannot diverge, and keeping one source removes any chance of
 * a mismatch creating orphan rows.
 */
export async function runAuthRescan(
  store: LensStore,
  spec: McpServerSpec,
  scannedAt: string,
  scan: typeof scanServer = scanServer,
): Promise<void> {
  try {
    const result = await scan(spec);
    store.upsertScanResult(result.definitions, result.bodies, []);
    store.recordServerScanStatus(spec.name, 'ok', scannedAt);
    const total = result.definitions.reduce((n, d) => n + d.definitionTokens, 0);
    console.log(`${spec.name}: login complete, ${result.definitions.length} tools · ${total} tokens`);
  } catch (e) {
    const record = classifyScanFailure(e);
    store.recordServerScanStatus(spec.name, record.status, scannedAt, record.errorCode);
    console.log(scanFailureLine(spec.name, e));
  } finally {
    store.save();
    store.close();
  }
}
