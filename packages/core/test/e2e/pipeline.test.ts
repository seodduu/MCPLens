import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LensStore } from '../../src/store/store.js';
import { buildMatrix } from '../../src/engine/engine.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';
import { GeminiAdapter } from '../../src/adapters/gemini/adapter.js';

// 픽스처 루트: packages/core/test/e2e → ../../../../fixtures (레포 루트/fixtures)
const fx = (p: string) =>
  readFileSync(path.join(__dirname, '../../../../fixtures', p), 'utf8');

describe('E2E 파이프라인 (3개 클라이언트 → 단일 매트릭스)', () => {
  it('3개 클라이언트 로그가 하나의 매트릭스로 통합된다', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(
      new ClaudeAdapter().parseFile('/fx/c.jsonl', fx('claude/session-toolsearch.jsonl')),
    );
    store.ingest(
      new CodexAdapter().parseFile('/fx/x.jsonl', fx('codex/rollout-codemode.jsonl')),
    );
    store.ingest(
      new GeminiAdapter().parseFile('/fx/g.jsonl', fx('gemini/chat-upfront.jsonl')),
    );

    const sessions = store.sessionsSince('2000-01-01');
    const calls = store.callsSince('2000-01-01');
    const loads = store.loadsSince('2000-01-01');

    const rows = buildMatrix({
      definitions: store.allDefinitions(),
      calls,
      loads,
      sessions,
    });

    // 매트릭스가 비어 있지 않다 (세 어댑터의 호출이 행으로 집계됨)
    expect(rows.length).toBeGreaterThan(0);

    // 세 클라이언트가 모두 세션으로 적재됐다
    const clients = new Set(sessions.map((s) => s.client));
    expect(clients).toEqual(new Set(['claude-code', 'codex', 'gemini-cli']));
    expect(clients.size).toBe(3);
  });

  it('Codex의 Err 호출이 어떤 행의 reliability.errorCount로 나타난다', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(
      new ClaudeAdapter().parseFile('/fx/c.jsonl', fx('claude/session-toolsearch.jsonl')),
    );
    store.ingest(
      new CodexAdapter().parseFile('/fx/x.jsonl', fx('codex/rollout-codemode.jsonl')),
    );
    store.ingest(
      new GeminiAdapter().parseFile('/fx/g.jsonl', fx('gemini/chat-upfront.jsonl')),
    );

    const calls = store.callsSince('2000-01-01');
    // 픽스처 사실: Codex 호출은 {Err: "user cancelled..."} → isError=true 케이스
    const errorCalls = calls.filter((c) => c.isError);
    expect(errorCalls.length).toBeGreaterThan(0);

    const rows = buildMatrix({
      definitions: store.allDefinitions(),
      calls,
      loads: store.loadsSince('2000-01-01'),
      sessions: store.sessionsSince('2000-01-01'),
    });

    const totalErrorCount = rows.reduce((n, r) => n + r.reliability.errorCount, 0);
    expect(totalErrorCount).toBeGreaterThan(0);
    expect(totalErrorCount).toBe(errorCalls.length);
  });

  it('Claude 세션의 tool_reference 로드가 loads로 집계된다', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(
      new ClaudeAdapter().parseFile('/fx/c.jsonl', fx('claude/session-toolsearch.jsonl')),
    );

    // 픽스처 사실: toolsearch 세션은 tool_reference 로드 신호를 포함
    const loads = store.loadsSince('2000-01-01');
    expect(loads.length).toBeGreaterThan(0);

    // MCP 실호출 5회 (PlayMCP) → 호출도 집계된다
    const calls = store.callsSince('2000-01-01');
    expect(calls.length).toBeGreaterThan(0);
  });
});
