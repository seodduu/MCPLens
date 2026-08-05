import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { geminiAdapter, splitFlattenedName } from '../../../src/adapters/gemini/adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  here,
  '../../../../../fixtures/gemini/chat-upfront.jsonl',
);
const fixture = readFileSync(fixturePath, 'utf8');

describe('splitFlattenedName', () => {
  it('strips the mcp_ prefix and splits server from tool at the first _', () => {
    expect(splitFlattenedName('mcp_github_list_issues')).toEqual({
      server: 'github',
      tool: 'list_issues',
    });
  });
  it('splits the fixture names correctly too', () => {
    expect(splitFlattenedName('mcp_lenstest_lens_get_weather')).toEqual({
      server: 'lenstest',
      tool: 'lens_get_weather',
    });
  });
  it('returns null for a builtin tool without the mcp_ prefix', () => {
    expect(splitFlattenedName('read_file')).toBeNull();
  });
  it('sets server=tool=rest when the remainder after mcp_ has no _', () => {
    expect(splitFlattenedName('mcp_solo')).toEqual({ server: 'solo', tool: 'solo' });
  });
});

describe('geminiAdapter.matches', () => {
  const root = path.join(os.homedir(), '.gemini', 'tmp');
  it('matches .gemini/tmp/<hash>/chats/*.jsonl', () => {
    expect(geminiAdapter.matches(path.join(root, 'abc123', 'chats', 's.jsonl'))).toBe(true);
  });
  it('matches the .json extension too', () => {
    expect(geminiAdapter.matches(path.join(root, 'abc123', 'chats', 's.json'))).toBe(true);
  });
  it('rejects paths outside chats', () => {
    expect(geminiAdapter.matches(path.join(root, 'abc123', 'notes', 's.jsonl'))).toBe(false);
  });
  it('rejects logs of other clients', () => {
    expect(
      geminiAdapter.matches(path.join(os.homedir(), '.claude', 'projects', 'x.jsonl')),
    ).toBe(false);
  });
});

describe('geminiAdapter.parseFile with the chat-upfront.jsonl fixture', () => {
  const result = geminiAdapter.parseFile(fixturePath, fixture);

  it('reports no parse errors', () => {
    expect(result.parseErrors).toBe(0);
  });

  it('reports one MCP toolCall (deduped across duplicate records)', () => {
    expect(result.toolCalls.length).toBe(1);
    const tc = result.toolCalls[0];
    expect(tc.serverName).toBe('lenstest');
    expect(tc.toolName).toBe('lens_get_weather');
    expect(tc.isError).toBe(false);
    expect(tc.calledAt).toBe('2026-07-18T17:16:49.857Z');
    expect(tc.responseTokens).toBe(0);
    expect(tc.externalCallId).toBe('mcp_lenstest_lens_get_weather__1jlcieln');
  });

  it('includes the untrusted_context wrapper in responseText', () => {
    expect(result.toolCalls[0].responseText).toContain('untrusted_context');
  });

  it('reports mode UPFRONT with an empty toolLoads', () => {
    expect(result.session.mode).toBe('UPFRONT');
    expect(result.toolLoads).toEqual([]);
  });

  it('fills session metadata: client, startedAt and sessionId (first 16 of the file path sha256)', () => {
    expect(result.session.client).toBe('gemini-cli');
    expect(result.session.startedAt).toBe('2026-07-18T17:16:43.930Z');
    expect(result.session.filePath).toBe(fixturePath);
    const expectedId = crypto
      .createHash('sha256')
      .update(fixturePath)
      .digest('hex')
      .slice(0, 16);
    expect(result.session.sessionId).toBe(expectedId);
    expect(result.session.externalSessionId).toBe('b0b95759-2271-4ec1-a4ef-88a649c60ba5');
  });

  it('normalizes blank native session/call IDs to null', () => {
    const content = [
      JSON.stringify({ sessionId: '  ', startTime: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({
        type: 'gemini', timestamp: '2026-07-20T00:00:01.000Z',
        toolCalls: [{ id: '\t', name: 'mcp_server_tool', status: 'success' }],
      }),
    ].join('\n');

    const parsed = geminiAdapter.parseFile('/fake/blank.jsonl', content);

    expect(parsed.session.externalSessionId).toBeNull();
    expect(parsed.toolCalls[0].externalCallId).toBeNull();
  });

  it('emits usage once per unique gemini record (2), avoiding double counting of streaming duplicates', () => {
    expect(result.usage.length).toBe(2);
    const totalInput = result.usage.reduce((s, u) => s + u.inputTokens, 0);
    // 17861 + 18237 (recounting the duplicate 17861 would exceed 35722)
    expect(totalInput).toBe(36098);
    const totalCacheRead = result.usage.reduce((s, u) => s + u.cacheReadTokens, 0);
    expect(totalCacheRead).toBe(16201);
    expect(result.usage.every((u) => u.cacheCreationTokens === 0)).toBe(true);
  });

  it('maps the usage tokens (input to inputTokens and so on)', () => {
    const first = result.usage[0];
    expect(first.inputTokens).toBe(17861);
    expect(first.outputTokens).toBe(24);
    expect(first.cacheReadTokens).toBe(0);
  });

  it('splits tokens.tool across several MCP calls in one record (the sum is preserved)', () => {
    const content = [
      JSON.stringify({ sessionId: 's-1', startTime: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({
        type: 'gemini',
        id: 'rec-1',
        timestamp: '2026-07-20T00:00:01.000Z',
        tokens: { input: 10, output: 5, cached: 0, tool: 100 },
        toolCalls: [
          { id: 'c1', name: 'mcp_alpha_one', status: 'success' },
          { id: 'c2', name: 'mcp_alpha_two', status: 'success' },
          { id: 'c3', name: 'mcp_alpha_three', status: 'success' },
        ],
      }),
    ].join('\n');

    const parsed = geminiAdapter.parseFile('/fake/multi.jsonl', content);

    expect(parsed.toolCalls.length).toBe(3);
    const total = parsed.toolCalls.reduce((s, t) => s + (t.responseTokens ?? 0), 0);
    // A multiplication bug would give 300
    expect(total).toBe(100);
    // The remainder adds 1 to the earlier calls
    expect(parsed.toolCalls.map((t) => t.responseTokens)).toEqual([34, 33, 33]);
  });

  it('distributes only by the MCP call count even when builtin tools are mixed in', () => {
    const content = JSON.stringify({
      type: 'gemini',
      id: 'rec-2',
      timestamp: '2026-07-20T00:00:01.000Z',
      tokens: { tool: 7 },
      toolCalls: [
        { id: 'c1', name: 'read_file', status: 'success' },
        { id: 'c2', name: 'mcp_alpha_one', status: 'success' },
        { id: 'c3', name: 'mcp_alpha_two', status: 'success' },
      ],
    });

    const parsed = geminiAdapter.parseFile('/fake/mixed.jsonl', content);

    expect(parsed.toolCalls.map((t) => t.responseTokens)).toEqual([4, 3]);
  });

  it('leaves responseTokens null when tokens.tool is absent', () => {
    const content = JSON.stringify({
      type: 'gemini',
      id: 'rec-3',
      timestamp: '2026-07-20T00:00:01.000Z',
      toolCalls: [
        { id: 'c1', name: 'mcp_alpha_one', status: 'success' },
        { id: 'c2', name: 'mcp_alpha_two', status: 'success' },
      ],
    });

    const parsed = geminiAdapter.parseFile('/fake/notokens.jsonl', content);

    expect(parsed.toolCalls.map((t) => t.responseTokens)).toEqual([null, null]);
  });

  it('does not apply the distribution twice when a duplicate streaming record exists', () => {
    const rec = {
      type: 'gemini',
      id: 'rec-4',
      timestamp: '2026-07-20T00:00:01.000Z',
      tokens: { tool: 9 },
      toolCalls: [
        { id: 'c1', name: 'mcp_alpha_one', status: 'success' },
        { id: 'c2', name: 'mcp_alpha_two', status: 'success' },
      ],
    };
    const parsed = geminiAdapter.parseFile(
      '/fake/dup.jsonl',
      [JSON.stringify(rec), JSON.stringify(rec)].join('\n'),
    );

    expect(parsed.toolCalls.length).toBe(2);
    expect(parsed.toolCalls.reduce((s, t) => s + (t.responseTokens ?? 0), 0)).toBe(9);
  });

  it('keeps sessionId consistent across every event', () => {
    const id = result.session.sessionId;
    expect(result.toolCalls.every((t) => t.sessionId === id)).toBe(true);
    expect(result.usage.every((u) => u.sessionId === id)).toBe(true);
  });
});
