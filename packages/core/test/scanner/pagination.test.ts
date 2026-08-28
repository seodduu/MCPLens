import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { scanServer } from '../../src/scanner/scanner.js';

interface ToolPage {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  nextCursor?: string;
}

function tool(name: string) {
  return {
    name,
    description: `Tool ${name} for the pagination test`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } } as Record<string, unknown>,
  };
}

/**
 * Starts a Streamable HTTP MCP server whose tools/list answers from a caller-supplied page table
 * keyed by the incoming cursor (the empty string is the first page). The low-level Server is used
 * instead of McpServer because only it lets the handler return an arbitrary `nextCursor`.
 * Stateless mode (`sessionIdGenerator: undefined`) builds a fresh server per request, so the page
 * table lives in this closure rather than on the server instance.
 */
async function startPaginatedMcp(
  pages: Record<string, ToolPage>,
): Promise<{ url: string; close: () => Promise<void>; requestedCursors: Array<string | undefined> }> {
  const requestedCursors: Array<string | undefined> = [];
  const httpServer: HttpServer = createServer((req, res) => {
    const mcp = new Server(
      { name: 'pagination-test', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, (request) => {
      const cursor = request.params?.cursor;
      requestedCursors.push(cursor);
      return pages[cursor ?? ''] ?? { tools: [] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err) => {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
    requestedCursors,
  };
}

describe('scanServer — paginated tools/list', () => {
  it('collects tools across every page of a paginated tools/list', async () => {
    const { url, close, requestedCursors } = await startPaginatedMcp({
      '': { tools: [tool('alpha'), tool('beta')], nextCursor: 'page-2' },
      'page-2': { tools: [tool('gamma')] },
    });
    try {
      const { definitions, bodies } = await scanServer({ name: 'pagetest', url });
      expect(definitions).toHaveLength(3);
      expect(definitions.map((d) => d.toolName)).toEqual(['alpha', 'beta', 'gamma']);
      expect(bodies).toHaveLength(3);
      expect(requestedCursors).toEqual([undefined, 'page-2']);
    } finally {
      await close();
    }
  });

  it('stops on a repeated cursor instead of looping forever', async () => {
    const { url, close } = await startPaginatedMcp({
      '': { tools: [tool('alpha')], nextCursor: 'stuck' },
      stuck: { tools: [tool('beta')], nextCursor: 'stuck' },
    });
    try {
      const result = await scanServer({ name: 'looptest', url });
      expect(result.definitions.map((d) => d.toolName)).toEqual(['alpha', 'beta']);
      expect(result.truncation).toEqual({ reason: 'repeated-cursor', pagesRead: 2 });
    } finally {
      await close();
    }
  }, 20000);

  it('keeps working when the server sends no nextCursor', async () => {
    const { url, close, requestedCursors } = await startPaginatedMcp({
      '': { tools: [tool('solo')] },
    });
    try {
      const result = await scanServer({ name: 'singlepage', url });
      expect(result.definitions).toHaveLength(1);
      expect(result.definitions[0].toolName).toBe('solo');
      expect(result.truncation).toBeUndefined();
      expect(requestedCursors).toEqual([undefined]);
    } finally {
      await close();
    }
  });
});
