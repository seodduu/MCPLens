import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientId } from '@mcp-lens/core';
import { captureHook, type CaptureReceipt } from '../src/hook-capture.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-hook-capture-'));
  roots.push(root);
  return root;
}

function fixture(client: 'claude' | 'codex' | 'gemini', name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve('fixtures/hooks', client, name), 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('captureHook', () => {
  it('fails open with the exact stdout contract for malformed JSON', () => {
    expect(captureHook('gemini-cli', '{secret:not-json}', NOW)).toEqual({
      stdout: '{}\n',
      exitCode: 0,
    });
  });

  it('fails open when timestamp normalization receives an invalid Date', () => {
    expect(captureHook('codex', '{}', new Date(Number.NaN))).toEqual({
      stdout: '{}\n',
      exitCode: 0,
    });
  });

  it.each<ClientId>(['claude-code', 'codex', 'gemini-cli'])(
    'always returns the normal %s stdout contract',
    (client) => {
      expect(captureHook(client, '{}', NOW)).toEqual({ stdout: '{}\n', exitCode: 0 });
    },
  );

  it('decodes and enqueues a valid payload through the durable inbox', () => {
    const root = temporaryRoot();
    const result = captureHook('codex', JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_use_id: 'call-1',
      tool_name: 'mcp__github__get_issue',
      transcript_path: null,
    }), NOW, { inbox: { root } });

    expect(result).toEqual({ stdout: '{}\n', exitCode: 0 });
    const [filename] = readdirSync(join(root, 'pending'));
    expect(filename).toMatch(/\.json$/);
    const persisted = readFileSync(join(root, 'pending', filename!), 'utf8');
    expect(persisted).toContain('"serverName":"github"');
    expect(persisted).not.toContain('tool_input');
    expect(persisted).not.toContain('tool_response');
  });

  it.each([
    ['claude-code', fixture('claude', 'post-tool-use.json')],
    ['codex', fixture('codex', 'post-tool-use.json')],
    ['gemini-cli', fixture('gemini', 'after-tool.json')],
  ] as const)('does not persist secret bodies from a valid %s payload', (client, base) => {
    const root = temporaryRoot();
    const receipts: CaptureReceipt[] = [];
    const payload = {
      ...base,
      prompt: { body: 'PROMPT_BODY_SENTINEL_2f81' },
      tool_input: { secret: 'TOOL_INPUT_SENTINEL_6a42' },
      tool_response: {
        content: 'TOOL_RESPONSE_SENTINEL_83bc',
        llmContent: 'LLM_CONTENT_SENTINEL_b113',
        returnDisplay: { message: 'RETURN_DISPLAY_SENTINEL_dd04' },
      },
    };

    expect(captureHook(client, JSON.stringify(payload), NOW, {
      inbox: { root },
      recordReceipt: (receipt) => receipts.push(receipt),
    })).toEqual({ stdout: '{}\n', exitCode: 0 });

    const [filename] = readdirSync(join(root, 'pending'));
    const persisted = readFileSync(join(root, 'pending', filename!), 'utf8');
    const diagnostics = JSON.stringify(receipts);
    for (const prohibited of [
      '"tool_input"',
      '"tool_response"',
      '"prompt"',
      'TOOL_INPUT_SENTINEL_6a42',
      'TOOL_RESPONSE_SENTINEL_83bc',
      'PROMPT_BODY_SENTINEL_2f81',
      ...(client === 'gemini-cli'
        ? [
            '"llmContent"',
            '"returnDisplay"',
            'LLM_CONTENT_SENTINEL_b113',
            'RETURN_DISPLAY_SENTINEL_dd04',
          ]
        : []),
    ]) {
      expect(persisted).not.toContain(prohibited);
      expect(diagnostics).not.toContain(prohibited);
    }
    expect(receipts).toEqual([expect.objectContaining({ client, status: 'queued' })]);
  });

  it('rejects input larger than 1 MiB without parsing or enqueueing it', () => {
    const root = temporaryRoot();
    const receipts: CaptureReceipt[] = [];

    expect(captureHook('claude-code', `{"secret":"${'x'.repeat(1024 * 1024)}"}`, NOW, {
      inbox: { root },
      recordReceipt: (receipt) => receipts.push(receipt),
    })).toEqual({ stdout: '{}\n', exitCode: 0 });

    expect(existsSync(join(root, 'pending'))).toBe(false);
    expect(receipts).toEqual([expect.objectContaining({ status: 'invalid', errorCode: 'payload-too-large' })]);
  });

  it('records decoder failure metadata without retaining raw payload or secrets', () => {
    const receipts: CaptureReceipt[] = [];
    const secret = 'super-secret-token';

    captureHook('claude-code', JSON.stringify({ secret }), NOW, {
      recordReceipt: (receipt) => receipts.push(receipt),
    });

    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain(secret);
    expect(JSON.stringify(receipts)).not.toContain('payload');
    expect(Object.keys(receipts[0]!)).toEqual([
      'client', 'kind', 'status', 'observedAt', 'errorCode',
    ]);
  });

  it('never opens LensStore on the hook capture path', () => {
    const openStore = vi.fn(() => { throw new Error('must not be called'); });

    expect(captureHook('codex', '{bad', NOW, { openStore })).toEqual({
      stdout: '{}\n',
      exitCode: 0,
    });
    expect(openStore).not.toHaveBeenCalled();
  });
});
