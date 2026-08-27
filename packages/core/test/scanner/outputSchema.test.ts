import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { scanServer } from '../../src/scanner/scanner.js';
import { computeDefinitionSetHash } from '../../src/scanner/serverIdentity.js';

/**
 * One tool publishes an outputSchema and the other does not, so a single scan exercises both
 * branches of the null-vs-value distinction the store keeps.
 */
async function startLocalHttpMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer: Server = createServer((req, res) => {
    const mcp = new McpServer({ name: 'output-schema-test', version: '0.0.1' });
    mcp.registerTool(
      'with_output',
      {
        description: 'Echo text back with a declared output shape',
        inputSchema: { text: z.string() },
        outputSchema: { echoed: z.string(), length: z.number() },
      },
      async ({ text }) => ({
        content: [{ type: 'text', text }],
        structuredContent: { echoed: text, length: text.length },
      }),
    );
    mcp.registerTool(
      'without_output',
      { description: 'Echo text back with a declared output shape', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
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
  };
}

describe('scanServer — outputSchema accounting', () => {
  it('records the output schema for the tool that publishes one, but does not charge it to the tokens', async () => {
    const { url, close } = await startLocalHttpMcp();
    try {
      const { definitions, bodies } = await scanServer({ name: 'outputtest', url });
      const withOutput = bodies.find((row) => row.toolName === 'with_output')!;
      const withoutOutput = bodies.find((row) => row.toolName === 'without_output')!;

      expect(withOutput.outputSchemaJson).toContain('"echoed"');
      expect(withoutOutput.outputSchemaJson).toBeNull();

      // The harness never sends outputSchema in the tool definition, so both tools (same
      // description and input shape) cost the same tokens even though only one publishes an
      // outputSchema in the stored body.
      const tokensOf = (toolName: string) =>
        definitions.find((row) => row.toolName === toolName)!.definitionTokens;
      expect(tokensOf('with_output')).toBe(tokensOf('without_output'));
      expect(withOutput.definitionTokens).toBe(tokensOf('with_output'));
    } finally {
      await close();
    }
  });

  it('gives two definition sets that differ only in outputSchema different hashes', () => {
    const base = { toolName: 'read', description: 'Read a record', inputSchema: { type: 'object' } };
    const withoutOutput = computeDefinitionSetHash('alpha', [base]);
    const withOutput = computeDefinitionSetHash('alpha', [
      { ...base, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    ]);
    const withEmptyOutput = computeDefinitionSetHash('alpha', [{ ...base, outputSchema: {} }]);

    expect(withOutput).not.toBe(withoutOutput);
    // "publishes an empty output" is a third distinct state, not the same as publishing nothing.
    expect(withEmptyOutput).not.toBe(withoutOutput);
    expect(withEmptyOutput).not.toBe(withOutput);
  });

  it('ignores key order inside the output schema when hashing', () => {
    const first = computeDefinitionSetHash('alpha', [{
      toolName: 'read', description: null, inputSchema: {},
      outputSchema: { b: 1, a: 2 },
    }]);
    const second = computeDefinitionSetHash('alpha', [{
      toolName: 'read', description: null, inputSchema: {},
      outputSchema: { a: 2, b: 1 },
    }]);

    expect(first).toBe(second);
  });
});
