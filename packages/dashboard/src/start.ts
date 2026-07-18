// packages/dashboard/src/start.ts
// 대시보드 실행 진입점: DB 를 열고 HTTP 서버를 기동한다.
import { LensStore, dbPath } from '@mcp-lens/core';
import { startDashboard } from './server.js';

async function main() {
  const file = dbPath();
  const port = Number(process.argv[2] ?? process.env.PORT ?? '43117');
  const store = await LensStore.open(file);
  await startDashboard(store, port, { watchFile: file });
  console.log(`MCP Lens 대시보드: http://127.0.0.1:${port}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
