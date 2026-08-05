// packages/cli/src/auth-target.ts
import { specTransport, type McpServerSpec } from '@mcp-lens/core';

/** Result of validating the auth command target (pure function, split out to be unit-testable). */
export type AuthTargetResult =
  | { ok: true; spec: McpServerSpec }
  | { ok: false; message: string };

/**
 * Finds the auth target spec by name.
 * Returns a failure with guidance when it is missing or is a stdio server (only http can auth).
 */
export function resolveAuthTarget(specs: McpServerSpec[], name: string): AuthTargetResult {
  const spec = specs.find((s) => s.name === name);
  if (!spec) {
    return {
      ok: false,
      message: `${name}: server not found (run mcp-lens scan to see the registered servers)`,
    };
  }
  if (specTransport(spec) !== 'http') {
    return {
      ok: false,
      message: `${name}: stdio servers need no authentication (http servers only)`,
    };
  }
  return { ok: true, spec };
}
