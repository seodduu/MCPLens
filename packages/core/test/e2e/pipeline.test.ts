import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LensStore } from '../../src/store/store.js';
import { buildMatrix } from '../../src/engine/engine.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';
import { GeminiAdapter } from '../../src/adapters/gemini/adapter.js';

// Fixture root: packages/core/test/e2e -> ../../../../fixtures (the repo root fixtures)
const fx = (p: string) =>
  readFileSync(path.join(__dirname, '../../../../fixtures', p), 'utf8');

describe('E2E pipeline (three clients into one matrix)', () => {
  it('merges the logs of three clients into a single matrix', async () => {
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

    // The matrix is not empty (calls from all three adapters aggregate into rows)
    expect(rows.length).toBeGreaterThan(0);

    // All three clients were ingested as sessions
    const clients = new Set(sessions.map((s) => s.client));
    expect(clients).toEqual(new Set(['claude-code', 'codex', 'gemini-cli']));
    expect(clients.size).toBe(3);
  });

  it('surfaces a Codex Err call as reliability.errorCount on some row', async () => {
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
    // Fixture fact: the Codex call is {Err: "user cancelled..."}, an isError=true case
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

  it('aggregates tool_reference loads from a Claude session as loads', async () => {
    const store = await LensStore.open(':memory:');
    store.ingest(
      new ClaudeAdapter().parseFile('/fx/c.jsonl', fx('claude/session-toolsearch.jsonl')),
    );

    // Fixture fact: the toolsearch session carries tool_reference load signals
    const loads = store.loadsSince('2000-01-01');
    expect(loads.length).toBeGreaterThan(0);

    // 5 real MCP calls (PlayMCP) are aggregated too
    const calls = store.callsSince('2000-01-01');
    expect(calls.length).toBeGreaterThan(0);
  });
});
