import type { ClientRowInput } from './collectionRows.js';

/**
 * Pure function deciding the guidance message the mcp-lens.installHooksAll command shows.
 * It references no vscode API, so unit tests can verify it directly.
 */

/** Message shown when targets (the install targets) is empty. */
export function noInstallTargetsMessage(inputs: ClientRowInput[]): string {
  const pendingApproval = inputs.find((input) => input.install === 'needs-approval');
  if (pendingApproval) {
    return `MCP Lens: approval for ${pendingApproval.client} is pending. `
      + `Open ${pendingApproval.client}'s /hooks and approve the MCP Lens hooks to continue.`;
  }
  return 'MCP Lens: hooks are already installed.';
}

/** Result message shown after attempting installation. When everything fails, the "installed hooks for" clause is dropped entirely. */
export function installedSummaryMessage(installed: string[], failedCount: number): string {
  if (installed.length === 0) return `MCP Lens: hook installation failed (${failedCount} failed).`;
  const failedNote = failedCount > 0 ? ` ${failedCount} failed.` : '';
  return `MCP Lens: installed hooks for ${installed.join(', ')}.${failedNote}`;
}
