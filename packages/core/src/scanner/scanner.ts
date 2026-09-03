import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { countTokens } from '../tokenize.js';
import type { ServerContextOverhead, ToolDefinition, ToolDefinitionBody } from '../types.js';
import { calibrate, estimateNameListTokens, ESTIMATOR_VERSION } from './calibration.js';
import { specTransport, type McpServerSpec } from './configs.js';
import { storedTokenProvider } from './oauth.js';
import { canonicalJson, computeDefinitionSetHash, toolToRawBody } from './serverIdentity.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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

/** Hard stop on the number of tools/list pages read, so a server that keeps handing out fresh
 *  cursors cannot spin the scan forever. */
const MAX_TOOL_PAGES = 50;

/** Why a tools/list walk stopped before the server said it was done. */
export interface ToolListTruncation {
  reason: 'repeated-cursor' | 'page-limit';
  pagesRead: number;
}

/**
 * Reads every page of tools/list, following `nextCursor` until the server stops sending one.
 * A single page is only the first slice: a server advertising more tools than its page size
 * (observed on @modelcontextprotocol/server-everything, 15 tools reported as 13) would otherwise
 * have its definition tokens under-counted and its unseen tools left out of the recommendations.
 * Stops early on a repeated cursor or at MAX_TOOL_PAGES and reports that instead of cutting silently.
 */
async function listAllTools(
  client: Client,
  serverName: string,
): Promise<{ tools: Awaited<ReturnType<Client['listTools']>>['tools']; truncation?: ToolListTruncation }> {
  const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pagesRead = 1; ; pagesRead += 1) {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    const next = page.nextCursor;
    if (next === undefined) return { tools };
    let truncation: ToolListTruncation | undefined;
    if (seenCursors.has(next)) truncation = { reason: 'repeated-cursor', pagesRead };
    else if (pagesRead >= MAX_TOOL_PAGES) truncation = { reason: 'page-limit', pagesRead };
    if (truncation) {
      // No logger in core, so the one channel that reaches every caller is stderr; the returned
      // field carries the same fact to callers that render it.
      console.warn(
        `mcp-lens: tools/list for "${serverName}" stopped after ${pagesRead} page(s) ` +
          `(${truncation.reason}); ${tools.length} tool(s) collected, the list may be incomplete`,
      );
      return { tools, truncation };
    }
    seenCursors.add(next);
    cursor = next;
  }
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
): Promise<{
  definitions: ToolDefinition[];
  bodies: ToolDefinitionBody[];
  overhead: ServerContextOverhead;
  /** Set only when the tools/list walk stopped early, so the caller can say the list is partial. */
  truncation?: ToolListTruncation;
}> {
  // Attach the stored Lens-issued token when present (non-interactive: a redirect throws).
  // Reused for the token-expired hint in the catch block to avoid a second read.
  const authProvider: AuthProvider | undefined = storedTokenProvider(spec) ?? undefined;
  const transport = createTransport(spec, authProvider);
  const client = new Client({ name: 'mcp-lens-scanner', version: '0.1.0' });
  const timer = setTimeout(() => transport.close(), timeoutMs);
  try {
    await client.connect(transport);
    const { tools, truncation } = await listAllTools(client, spec.name);
    const now = new Date().toISOString();
    const rawBodies = tools.map(toolToRawBody);
    const definitionSetHash = computeDefinitionSetHash(spec.name, rawBodies);
    const definitions: ToolDefinition[] = tools.map((t) => {
      // The harness only ever sends {name, description, input_schema} in the tool definition
      // (Anthropic Messages API); outputSchema is not part of that payload, so it is excluded
      // here even though the row's body keeps it for dependency-tier reads. The name counted is
      // the fully qualified name the harness actually sends: "mcp__<server>__<tool>".
      const advertisedTokens = countTokens(
        JSON.stringify({
          name: `mcp__${spec.name}__${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        }),
      );
      return {
        serverName: spec.name,
        toolName: t.name,
        advertisedTokens,
        definitionTokens: calibrate(advertisedTokens),
        nameListTokens: estimateNameListTokens(spec.name, t.name, t.description ?? null),
        estimatorVersion: ESTIMATOR_VERSION,
        scannedAt: now,
        firstScannedAt: now, // COALESCE on save preserves the existing first value
      };
    });
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
    // The initialize response's `instructions` string is a per-server cost no single tool owns:
    // Claude Code puts it in the system prompt, so removing the server removes it but filtering
    // individual tools does not (docs/plans/2026-08-27-툴정의-토큰-추정기-v2-구현계획.md 3.5절).
    const instructions = client.getInstructions();
    const overhead: ServerContextOverhead = {
      serverName: spec.name,
      instructionsTokens: instructions ? calibrate(countTokens(instructions)) : 0,
      instructionsSha256: instructions ? sha256(instructions) : null,
      estimatorVersion: ESTIMATOR_VERSION,
      scannedAt: now,
    };
    return { definitions, bodies, overhead, ...(truncation ? { truncation } : {}) };
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
