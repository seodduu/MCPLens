/**
 * Recovery path that keeps a failed DB open from turning into a failed activation.
 *
 * When `~/.mcplens/lens.db` is corrupted, sql.js throws, and if that exception escapes activate,
 * VS Code shows a single "activation failed" line. Every command that would have been registered
 * afterwards disappears and the user has no way to act. So the corrupted file is backed up with a
 * timestamp and a fresh empty DB is started; failing even that, it falls back to an in-memory DB and keeps the extension alive.
 */

export const MEMORY_DB_PATH = ':memory:';

export interface StoreOpenDeps<S> {
  /** Really LensStore.open. Tests inject a fake. */
  open(filePath: string): Promise<S>;
  exists(filePath: string): boolean;
  rename(from: string, to: string): void;
  now(): Date;
}

export type StoreOpenOutcome<S> =
  | { kind: 'ok'; store: S }
  | { kind: 'recovered'; store: S; backupPath: string; message: string }
  | { kind: 'degraded'; store: S; message: string }
  | { kind: 'failed'; message: string };

/**
 * Backup path. The colons of an ISO timestamp are illegal in Windows file names, so they become hyphens.
 */
export function corruptBackupPath(filePath: string, now: Date): string {
  return `${filePath}.corrupt-${now.toISOString().replace(/:/g, '-')}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function openStoreWithRecovery<S>(
  filePath: string, deps: StoreOpenDeps<S>,
): Promise<StoreOpenOutcome<S>> {
  try {
    return { kind: 'ok', store: await deps.open(filePath) };
  } catch (firstError) {
    if (deps.exists(filePath)) {
      const backupPath = corruptBackupPath(filePath, deps.now());
      try {
        deps.rename(filePath, backupPath);
        const store = await deps.open(filePath); // the file is gone, so this opens an empty DB
        return {
          kind: 'recovered', store, backupPath,
          message: `MCP Lens: the database was corrupted, so it was backed up and started fresh. `
            + `The backup is at ${backupPath}. Past collection records refill through scans and hook collection.`,
        };
      } catch (backupError) {
        return memoryFallback(deps, `${reasonOf(firstError)} / ${reasonOf(backupError)}`);
      }
    }
    return memoryFallback(deps, reasonOf(firstError));
  }
}

async function memoryFallback<S>(deps: StoreOpenDeps<S>, reason: string): Promise<StoreOpenOutcome<S>> {
  try {
    const store = await deps.open(MEMORY_DB_PATH);
    return {
      kind: 'degraded', store,
      message: `MCP Lens: the database file cannot be written, so it runs in memory only (cause: ${reason}). `
        + `Nothing collected in this window will be saved. `
        + `Check the permissions of the ~/.mcplens directory, or move lens.db aside, then reopen the window.`,
    };
  } catch (memoryError) {
    return {
      kind: 'failed',
      message: `MCP Lens: the database could not be opened (cause: ${reason} / ${reasonOf(memoryError)}). `
        + `Check the permissions of the ~/.mcplens directory, then reopen the window.`,
    };
  }
}
