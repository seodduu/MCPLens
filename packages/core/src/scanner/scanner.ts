import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { countTokens } from '../tokenize.js';
import type { ToolDefinition } from '../types.js';
import { specTransport, type McpServerSpec } from './configs.js';

/** HTTP 응답/에러 메시지에서 인증 요구(401/403·OAuth) 신호를 감지한다. */
function isAuthRequired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|\b403\b|unauthor|forbidden|oauth|invalid_token|www-authenticate/i.test(msg);
}

/** spec의 전송 방식에 맞는 클라이언트 transport를 생성한다 (생성만 분기, 이후 로직은 공유). */
function createTransport(spec: McpServerSpec): Transport {
  const kind = specTransport(spec);
  if (kind === 'stdio') {
    return new StdioClientTransport({
      command: spec.command!,
      args: spec.args,
      env: spec.env,
    });
  }
  if (kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(spec.url!));
  }
  throw new Error(`unknown transport: ${spec.name}`);
}

/**
 * 지정된 MCP 서버를 stdio 또는 streamable http로 기동해 tools/list를 조회하고
 * 정의 토큰을 계산한다. stdio는 프로세스 spawn, http는 네트워크를 사용하므로
 * 실기기 자원 검증은 Wave 4 스모크에서 다룬다 (http는 루프백 유닛테스트 존재).
 * 인증 요구(401/403·OAuth) http 서버는 메시지에 `auth-required`를 포함해 throw한다.
 */
export async function scanServer(
  spec: McpServerSpec,
  timeoutMs = 15000,
): Promise<ToolDefinition[]> {
  const transport = createTransport(spec);
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
  } catch (err) {
    // 인증 요구는 정상 실패 — 표면이 "인증 필요 — 스킵"으로 안내하도록 신호를 담는다.
    if (isAuthRequired(err)) {
      throw new Error(`auth-required: ${spec.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
