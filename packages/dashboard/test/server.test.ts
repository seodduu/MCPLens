import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { LensStore, type AdapterResult } from '@mcp-lens/core';
import { startDashboard } from '../src/server.js';

const FIXED_ISO = new Date().toISOString();

function fakeResult(overrides: Partial<AdapterResult> = {}): AdapterResult {
  return {
    session: {
      sessionId: 'sess-1',
      client: 'claude-code',
      filePath: '/fake/session-1.jsonl',
      startedAt: FIXED_ISO,
      mode: 'UPFRONT',
    },
    toolCalls: [
      {
        sessionId: 'sess-1',
        serverName: 'github',
        toolName: 'search_issues',
        calledAt: FIXED_ISO,
        durationMs: 120,
        isError: false,
        responseTokens: 42,
        responseText: null,
      },
    ],
    toolLoads: [],
    usage: [],
    parseErrors: 0,
    ...overrides,
  };
}

describe('dashboard HTTP contract', () => {
  let server: Awaited<ReturnType<typeof startDashboard>>;
  let baseUrl: string;
  let store: LensStore;

  beforeAll(async () => {
    store = await LensStore.open(':memory:');
    store.upsertDefinitions([
      { serverName: 'github', toolName: 'search_issues', definitionTokens: 500, scannedAt: FIXED_ISO },
      { serverName: 'github', toolName: 'create_issue', definitionTokens: 300, scannedAt: FIXED_ISO },
    ]);
    store.ingest(fakeResult());

    server = await startDashboard(store, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  it('GET /api/matrix returns rows and savings', async () => {
    const res = await fetch(`${baseUrl}/api/matrix?days=30`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    const usedRow = body.rows.find(
      (r: { serverName: string; toolName: string }) =>
        r.serverName === 'github' && r.toolName === 'search_issues',
    );
    expect(usedRow.callCount).toBe(1);
    expect(usedRow.recommendation.action).toBe('keep');
    expect(usedRow.reliability).toBeDefined();
    expect(usedRow.reliability.errorRate).toBe(0);
    expect('loadPattern' in usedRow).toBe(true);
    expect(body.savings).toBeDefined();
    expect(typeof body.savings.potentialTokens).toBe('number');
  });

  it('GET /api/matrix defaults days to 30 when omitted', async () => {
    const res = await fetch(`${baseUrl}/api/matrix`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('GET /api/sessions returns session list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions?days=7`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].sessionId).toBe('sess-1');
  });

  it('GET /api/timeline/:sessionId returns that session calls', async () => {
    const res = await fetch(`${baseUrl}/api/timeline/sess-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].toolName).toBe('search_issues');
  });

  it('GET /api/timeline/:sessionId returns empty array for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/timeline/does-not-exist`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it('unknown /api route returns 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/nonsense`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('GET / serves something (static shell, even if build output absent)', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect([200, 404]).toContain(res.status);
  });
});

describe('dashboard with :memory: store (no watchFile → no reload path)', () => {
  it('API 는 정상 동작하고 파일 재로딩을 시도하지 않는다', async () => {
    const memStore = await LensStore.open(':memory:');
    memStore.upsertDefinitions([
      { serverName: 'github', toolName: 'search_issues', definitionTokens: 500, scannedAt: FIXED_ISO },
    ]);
    memStore.ingest(fakeResult());
    // watchFile 미지정 → 파일 stat/재오픈 경로를 타지 않음
    const srv = await startDashboard(memStore, 0);
    const addr = srv.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/matrix`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.rows)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      memStore.close();
    }
  });
});
