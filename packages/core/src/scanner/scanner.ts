import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { countTokens } from '../tokenize.js';
import type { ToolDefinition, ToolDefinitionBody } from '../types.js';
import { specTransport, type McpServerSpec } from './configs.js';
import { storedTokenProvider } from './oauth.js';
import { canonicalJson, computeDefinitionSetHash, toolToRawBody } from './serverIdentity.js';

type AuthProvider = NonNullable<ReturnType<typeof storedTokenProvider>>;

/** Detects an authentication demand (401/403, OAuth) in an HTTP response or error message.
 *  Some servers (GitHub remote MCP) reject with 400 + "missing required Authorization header"
 *  instead of a standard 401, so a mention of the Authorization header counts too (observed on a real device, 2026-07-20). */
export function isAuthRequired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|\b403\b|unauthor|forbidden|oauth|invalid_token|www-authenticate|authorization header/i.test(msg);
}

/** Creates the client transport matching the spec's transport (only creation branches; the rest is shared). */
function createTransport(spec: McpServerSpec, authProvider: AuthProvider | undefined): Transport {
  const kind = specTransport(spec);
  if (kind === 'stdio') {
    return new StdioClientTransport({
      command: spec.command!,
      args: spec.args,
      env: spec.env,
    });
  }
  if (kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(spec.url!), {
      ...(authProvider ? { authProvider } : {}),
      // Pass through custom headers such as a PAT (the headers field of the config, for GitHub remote MCP and friends)
      ...(spec.headers ? { requestInit: { headers: spec.headers } } : {}),
    });
  }
  throw new Error(`unknown transport: ${spec.name}`);
}

/**
 * Starts the given MCP server over stdio or streamable http, queries tools/list and computes the
 * definition tokens. stdio spawns a process and http uses the network, so real-device resource
 * verification happens in the Wave 4 smoke run (http does have a loopback unit test).
 * An http server demanding authentication (401/403, OAuth) throws with `auth-required` in the message.
 */
export async function scanServer(
  spec: McpServerSpec,
  timeoutMs = 15000,
): Promise<{ definitions: ToolDefinition[]; bodies: ToolDefinitionBody[] }> {
  // Attach the stored Lens-issued token when present (non-interactive: a redirect throws).
  // Reused for the token-expired hint in the catch block to avoid a second read.
  const authProvider: AuthProvider | undefined = storedTokenProvider(spec) ?? undefined;
  const transport = createTransport(spec, authProvider);
  const client = new Client({ name: 'mcp-lens-scanner', version: '0.1.0' });
  const timer = setTimeout(() => transport.close(), timeoutMs);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const now = new Date().toISOString();
    const rawBodies = tools.map(toolToRawBody);
    const definitionSetHash = computeDefinitionSetHash(spec.name, rawBodies);
    const definitions: ToolDefinition[] = tools.map((t) => ({
      serverName: spec.name,
      toolName: t.name,
      // The client injects the whole tool object into context, outputSchema included. Counting only
      // name+description+inputSchema under-reports the definition cost and therefore the savings.
      definitionTokens: countTokens(
        JSON.stringify({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...((t as { outputSchema?: unknown }).outputSchema === undefined
            ? {}
            : { outputSchema: (t as { outputSchema?: unknown }).outputSchema }),
        }),
      ),
      scannedAt: now,
      firstScannedAt: now, // COALESCE on save preserves the existing first value
    }));
    const bodies: ToolDefinitionBody[] = definitions.map((definition, index) => ({
      serverName: definition.serverName,
      toolName: definition.toolName,
      description: rawBodies[index].description ?? null,
      inputSchemaJson: canonicalJson(rawBodies[index].inputSchema),
      outputSchemaJson: rawBodies[index].outputSchema === undefined
        ? null
        : canonicalJson(rawBodies[index].outputSchema),
      definitionTokens: definition.definitionTokens,
      definitionSetHash,
      scannedAt: now,
    }));
    return { definitions, bodies };
  } catch (err) {
    // An authentication demand is a normal failure; carry the signal so the surface can say "authentication required, skipped".
    if (isAuthRequired(err)) {
      const base = err instanceof Error ? err.message : String(err);
    // Authentication failed even with a stored token, so treat it as expired + refresh failure and add a re-login hint.
      const hadTokens = authProvider != null;
      const hint = hadTokens ? ' (token-expired)' : '';
      throw new Error(`auth-required: ${spec.name} — ${base}${hint}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
