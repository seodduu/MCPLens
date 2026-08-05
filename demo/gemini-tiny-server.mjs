// Dummy MCP stdio server for Gemini CLI: 3 tools.
// Each tool definition is kept minimal (about 1 token): a single-character name, no description, no parameters.
// Registration: add the entry below to mcpServers in ~/.gemini/settings.json
//   "tiny": { "command": "node", "args": ["/path/to/MCPLens-V2/demo/gemini-tiny-server.mjs"] }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'tiny', version: '0.1.0' });

const text = (s) => ({ content: [{ type: 'text', text: s }] });

// One-character names with no description and no input schema keep the tool definition tokens minimal.
for (const name of ['a', 'b', 'c']) {
  server.tool(name, async () => text('ok'));
}

await server.connect(new StdioServerTransport());
