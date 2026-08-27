import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { scanServer } from '../../src/scanner/scanner.js';
import { calibrate, HARNESS_FACTOR } from '../../src/scanner/calibration.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/calibration/day-01.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  meanV1ErrorRate: number;
  meanV2ErrorRate: number;
  servers: Array<{
    name: string;
    advertisedTokens: number;
    instructionsTokens: number;
    measuredTokens: number;
    v1EstimateTokens: number;
  }>;
};

/**
 * Starts a Streamable HTTP MCP server on local loopback, optionally publishing instructions.
 * Mirrors the pattern in scan-http.test.ts / outputSchema.test.ts.
 */
async function startLocalHttpMcp(
  registerTools: (mcp: McpServer) => void,
  serverOptions?: { instructions?: string },
): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer: Server = createServer((req, res) => {
    const mcp = new McpServer({ name: 'calibration-test', version: '0.0.1' }, serverOptions);
    registerTools(mcp);
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

describe('scanner v2 calibration', () => {
  it('excludes outputSchema from the token count', async () => {
    const { url, close } = await startLocalHttpMcp((mcp) => {
      mcp.registerTool(
        'with_output',
        {
          description: 'Echo text back',
          inputSchema: { text: z.string() },
          outputSchema: { echoed: z.string(), length: z.number(), extra: z.string(), more: z.string() },
        },
        async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: {} }),
      );
      mcp.registerTool(
        'without_output',
        { description: 'Echo text back', inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
    });
    try {
      const { definitions } = await scanServer({ name: 'sameserver', url });
      const withOutput = definitions.find((d) => d.toolName === 'with_output')!;
      const withoutOutput = definitions.find((d) => d.toolName === 'without_output')!;
      expect(withOutput.advertisedTokens).toBe(withoutOutput.advertisedTokens);
    } finally {
      await close();
    }
  });

  it('counts the fully qualified tool name', async () => {
    const registerEcho = (mcp: McpServer) => {
      mcp.registerTool(
        'echo',
        { description: 'Echo text back', inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
    };
    const short = await startLocalHttpMcp(registerEcho);
    const long = await startLocalHttpMcp(registerEcho);
    try {
      const shortResult = await scanServer({ name: 's', url: short.url });
      const longResult = await scanServer({
        name: 'a-much-longer-server-name-that-inflates-the-qualified-tool-name',
        url: long.url,
      });
      expect(longResult.definitions[0].advertisedTokens).toBeGreaterThan(
        shortResult.definitions[0].advertisedTokens!,
      );
    } finally {
      await short.close();
      await long.close();
    }
  });

  it('calibrated tokens are the advertised tokens times the harness factor', async () => {
    const { url, close } = await startLocalHttpMcp((mcp) => {
      mcp.registerTool(
        'echo',
        { description: 'Echo text back for calibration factor test', inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
    });
    try {
      const { definitions } = await scanServer({ name: 'factortest', url });
      const def = definitions[0];
      expect(def.definitionTokens).toBe(Math.round(def.advertisedTokens! * HARNESS_FACTOR));
    } finally {
      await close();
    }
  });

  it('stores zero instructions tokens when the server publishes none', async () => {
    const { url, close } = await startLocalHttpMcp((mcp) => {
      mcp.registerTool(
        'echo',
        { description: 'Echo text back', inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
    });
    try {
      const { overhead } = await scanServer({ name: 'noinstructions', url });
      expect(overhead.instructionsTokens).toBe(0);
      expect(overhead.instructionsSha256).toBeNull();
    } finally {
      await close();
    }
  });

  it('matches the measured day-01 weights within 10 percent on average', () => {
    const errorRates = fixture.servers.map((s) => {
      const calibrated = calibrate(s.advertisedTokens + s.instructionsTokens);
      return Math.abs(calibrated - s.measuredTokens) / s.measuredTokens;
    });
    const mean = errorRates.reduce((a, b) => a + b, 0) / errorRates.length;
    expect(mean).toBeLessThan(0.1);
    expect(mean).toBeCloseTo(fixture.meanV2ErrorRate, 3);
  });

  it('the uncalibrated estimator would have failed the same bar', () => {
    const errorRates = fixture.servers.map((s) => {
      const measured = s.measuredTokens;
      return Math.abs(s.v1EstimateTokens - measured) / measured;
    });
    const mean = errorRates.reduce((a, b) => a + b, 0) / errorRates.length;
    expect(mean).toBeCloseTo(fixture.meanV1ErrorRate, 3);
    expect(mean).toBeGreaterThan(0.1);
  });
});
