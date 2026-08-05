import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { scanServer } from '../../src/scanner/scanner.js';

interface ToolSpec {
  name: string;
  description: string;
}

/**
 * Starts a Streamable HTTP MCP server on local loopback (127.0.0.1:0, an ephemeral port).
 * Stateless mode (`sessionIdGenerator: undefined`) creates a fresh server and transport per request.
 */
async function startLocalHttpMcp(
  tools: ToolSpec[],
): Promise<{ url: string; close: () => Promise<void>; seenHeaders: Array<Record<string, unknown>> }> {
  const seenHeaders: Array<Record<string, unknown>> = [];
  const httpServer: Server = createServer((req, res) => {
    seenHeaders.push({ ...req.headers });
    const mcp = new McpServer({ name: 'local-http-test', version: '0.0.1' });
    for (const t of tools) {
      mcp.registerTool(
        t.name,
        { description: t.description, inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
    }
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
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
    seenHeaders,
  };
}

describe('scanServer — http transport', () => {
  it('scans an http server with tools/list and computes the definition tokens', async () => {
    const { url, close } = await startLocalHttpMcp([
      { name: 'echo', description: 'Echo back text for http scan test' },
    ]);
    try {
      const result = await scanServer({ name: 'httptest', url });
      expect(result.definitions).toHaveLength(1);
      expect(result.definitions[0].serverName).toBe('httptest');
      expect(result.definitions[0].toolName).toBe('echo');
      expect(result.definitions[0].definitionTokens).toBeGreaterThan(0);
      expect(result.bodies).toEqual([
        expect.objectContaining({
          serverName: 'httptest',
          toolName: 'echo',
          description: 'Echo back text for http scan test',
          definitionTokens: result.definitions[0].definitionTokens,
        }),
      ]);
      expect(result.bodies[0].inputSchemaJson).toContain('"text"');
      expect(result.bodies[0].definitionSetHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await close();
    }
  });

  it('passes spec.headers through as real HTTP request headers (PAT pass-through)', async () => {
    const { url, close, seenHeaders } = await startLocalHttpMcp([
      { name: 'echo', description: 'Echo for header passthrough test' },
    ]);
    try {
      await scanServer({ name: 'pat-test', url,
        headers: { Authorization: 'Bearer test-pat-123', 'X-Custom': 'lens' } });
      expect(seenHeaders.length).toBeGreaterThan(0);
      for (const h of seenHeaders) {
        expect(h['authorization']).toBe('Bearer test-pat-123');
        expect(h['x-custom']).toBe('lens');
      }
    } finally {
      await close();
    }
  });

  it('throws for an unknown transport', async () => {
    await expect(scanServer({ name: 'x' })).rejects.toThrow(/unknown transport/);
  });
});

describe('broader isAuthRequired classification', () => {
  it('classifies a GitHub-style 400 with an Authorization header message as an authentication demand', async () => {
    const { isAuthRequired } = await import('../../src/scanner/scanner.js');
    expect(isAuthRequired(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: bad request: missing required Authorization header'))).toBe(true);
    expect(isAuthRequired(new Error('connection refused'))).toBe(false);
  });
});
