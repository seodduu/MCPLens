import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { countTokens } from '../tokenize.js';
import type { ToolDefinition } from '../types.js';
import type { McpServerSpec } from './configs.js';

/**
 * 지정된 MCP 서버를 stdio로 기동해 tools/list를 조회하고 정의 토큰을 계산한다.
 * 실기기 자원(프로세스 spawn)을 사용하므로 유닛테스트 대상이 아니다 — Wave 4 스모크에서 검증.
 */
export async function scanServer(
  spec: McpServerSpec,
  timeoutMs = 15000,
): Promise<ToolDefinition[]> {
  if (!spec.command) throw new Error('stdio spec without command');
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
  });
  const client = new Client({ name: 'mcp-lens-scanner', version: '0.1.0' });
  const timer = setTimeout(() => transport.close(), timeoutMs);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const now = new Date().toISOString();
    return tools.map((t) => ({
      serverName: spec.name,
      toolName: t.name,
      definitionTokens: countTokens(
        JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }),
      ),
      scannedAt: now,
    }));
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
