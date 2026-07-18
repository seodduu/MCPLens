// packages/dashboard/src/server.ts
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LensStore,
  buildMatrix,
  sessionSavings,
  type EngineInput,
} from '@mcp-lens/core';

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function loadEngineInput(store: LensStore, since: string): EngineInput {
  return {
    definitions: store.allDefinitions(),
    calls: store.callsSince(since),
    loads: store.loadsSince(since),
    sessions: store.sessionsSince(since),
  };
}

function parseDays(url: URL, fallback: number): number {
  const raw = url.searchParams.get('days');
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const resolved = normalize(join(STATIC_ROOT, relative));

  // 경로 탈출 방지 (../ 등)
  if (!resolved.startsWith(STATIC_ROOT + sep) && resolved !== STATIC_ROOT) {
    res.writeHead(403);
    res.end();
    return;
  }

  const target = existsSync(resolved) && statSync(resolved).isFile()
    ? resolved
    : join(STATIC_ROOT, 'index.html');

  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('build output not found — run `npm run build` in packages/dashboard');
    return;
  }

  const mime = MIME[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime });
  createReadStream(target).pipe(res);
}

export async function startDashboard(
  store: LensStore,
  port: number,
  opts?: { watchFile?: string },
): Promise<http.Server> {
  // 파일 기반 store 는 장시간 구동 시 파일이 갱신되어도 sql.js 인메모리 사본이 stale 해진다.
  // /api/* 요청 처리 전 mtime 을 확인해 변경되었으면 재오픈해 교체한다.
  // :memory: 등 파일 백엔드가 아닌 경우(watchFile 미지정)에는 검사를 건너뛴다.
  let current = store;
  const watchFile = opts?.watchFile;
  let lastMtimeMs = watchFile && existsSync(watchFile) ? statSync(watchFile).mtimeMs : null;

  async function maybeReload(): Promise<void> {
    if (!watchFile || !existsSync(watchFile)) return;
    const mtimeMs = statSync(watchFile).mtimeMs;
    if (lastMtimeMs !== null && mtimeMs === lastMtimeMs) return;
    lastMtimeMs = mtimeMs;
    const next = await LensStore.open(watchFile);
    const prev = current;
    current = next;
    prev.close();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      maybeReload()
        .catch(() => {})
        .finally(() => handleApi(current, url, pathname, res));
      return;
    }

    serveStatic(req, res, pathname);
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

function handleApi(store: LensStore, url: URL, pathname: string, res: ServerResponse): void {
    if (pathname === '/api/matrix') {
      const since = sinceIso(parseDays(url, 30));
      const input = loadEngineInput(store, since);
      sendJson(res, 200, { rows: buildMatrix(input), savings: sessionSavings(input) });
      return;
    }

    if (pathname === '/api/sessions') {
      const since = sinceIso(parseDays(url, 7));
      sendJson(res, 200, store.sessionsSince(since));
      return;
    }

    if (pathname.startsWith('/api/timeline/')) {
      const sessionId = decodeURIComponent(pathname.slice('/api/timeline/'.length));
      const since = new Date(0).toISOString();
      const calls = store
        .callsSince(since)
        .filter((c) => c.sessionId === sessionId)
        .sort((a, b) => (a.calledAt ?? '').localeCompare(b.calledAt ?? ''));
      sendJson(res, 200, calls);
      return;
    }

    sendJson(res, 404, { error: 'not found', path: pathname });
}
