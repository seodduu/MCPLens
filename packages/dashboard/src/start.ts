// packages/dashboard/src/start.ts
// Dashboard entry point: opens the DB and starts the HTTP server.
import { LensStore, dbPath } from '@mcp-lens/core';
import { startDashboard } from './server.js';

async function main() {
  const file = dbPath();
  const port = Number(process.argv[2] ?? process.env.PORT ?? '43117');
  const store = await LensStore.open(file);
  await startDashboard(store, port, { watchFile: file });
  console.log(`MCP Lens dashboard: http://127.0.0.1:${port}`);
}

// Show one actionable line instead of a stack trace.
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
