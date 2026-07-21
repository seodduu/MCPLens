// Gemini CLI용 더미 MCP stdio 서버 — 툴 3개.
// 각 툴의 정의 크기를 최소(≈1토큰)로: 단일 문자 이름 + 설명 없음 + 파라미터 없음.
// 등록: ~/.gemini/settings.json 의 mcpServers 에 아래 항목 추가
//   "tiny": { "command": "node", "args": ["/Users/doo._.hyun/Study/Project/MCPLens/demo/gemini-tiny-server.mjs"] }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'tiny', version: '0.1.0' });

const text = (s) => ({ content: [{ type: 'text', text: s }] });

// 이름 한 글자, 설명·입력 스키마 없음 → 툴 정의 토큰을 최소화.
for (const name of ['a', 'b', 'c']) {
  server.tool(name, async () => text('ok'));
}

await server.connect(new StdioServerTransport());
