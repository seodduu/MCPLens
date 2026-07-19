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
 * 로컬 루프백에 Streamable HTTP MCP 서버를 띄운다 (127.0.0.1:0 임시 포트).
 * stateless 모드(`sessionIdGenerator: undefined`)로, 요청마다 새 server+transport를 생성한다.
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
  it('http 서버를 tools/list로 스캔해 정의 토큰을 계산한다', async () => {
    const { url, close } = await startLocalHttpMcp([
      { name: 'echo', description: 'Echo back text for http scan test' },
    ]);
    try {
      const defs = await scanServer({ name: 'httptest', url });
      expect(defs).toHaveLength(1);
      expect(defs[0].serverName).toBe('httptest');
      expect(defs[0].toolName).toBe('echo');
      expect(defs[0].definitionTokens).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('spec.headers가 실제 HTTP 요청 헤더로 전달된다 (PAT 패스스루)', async () => {
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

  it('unknown 전송은 throw', async () => {
    await expect(scanServer({ name: 'x' })).rejects.toThrow(/unknown transport/);
  });
});

describe('isAuthRequired 분류 확대', () => {
  it('GitHub식 400 + Authorization header 메시지도 인증 요구로 분류', async () => {
    const { isAuthRequired } = await import('../../src/scanner/scanner.js');
    expect(isAuthRequired(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: bad request: missing required Authorization header'))).toBe(true);
    expect(isAuthRequired(new Error('connection refused'))).toBe(false);
  });
});
