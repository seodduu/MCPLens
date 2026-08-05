// packages/extension/src/authDecision.ts (never import vscode)
import type { McpServerSpec } from '@mcp-lens/core';

export type AuthPromptAction =
  | { kind: 'skip' }
  | { kind: 'prompt'; targets: McpServerSpec[] };

/**
 * Picks which of the servers that failed with auth-required (including token expiry) to notify about.
 * - ignoreList: servers permanently ignored with 'do not ask for this server' (stored in settings).
 * - sessionSnoozed: servers suppressed with 'Later' for this VS Code session only (reset on restart).
 * - unsupported: servers judged unsupported by Lens, DCR refusal and the like (permanent, never re-prompted).
 */
export function decideAuthPrompt(args: {
  failedServers: McpServerSpec[];
  ignoreList: string[];
  sessionSnoozed?: string[];
  unsupported?: string[];
}): AuthPromptAction {
  const suppressed = new Set([
    ...args.ignoreList, ...(args.sessionSnoozed ?? []), ...(args.unsupported ?? []),
  ]);
  const targets = args.failedServers.filter((s) => !suppressed.has(s.name));
  if (targets.length === 0) return { kind: 'skip' };
  return { kind: 'prompt', targets };
}

/**
 * Decides whether the server refuses dynamic client registration (DCR).
 * When the registration endpoint returns 403 Forbidden (Figma, say), it fails before the browser even
 * opens. Lens cannot log in to such a server, so it is handled as an unsupported server.
 */
export function isDcrRejected(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /dynamic client registration/i.test(raw) ||
    (/\b403\b/.test(raw) && /forbidden/i.test(raw));
}

/** Turns a normal login failure (not a DCR refusal) into user-facing wording. */
export function friendlyAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `Sign-in failed. ${raw}`;
}
