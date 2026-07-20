import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HookNormalizationResult } from '../../../src/ingest/contracts.js';
import { decodeGeminiHook } from '../../../src/ingest/clients/gemini/decoder.js';

const loadJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as unknown;

const receivedAt = '2026-07-20T02:00:00.000Z';

function observation(result: HookNormalizationResult) {
  expect(result.kind).toBe('observation');
  if (result.kind !== 'observation') throw new Error('expected observation');
  return result.observation;
}

describe('decodeGeminiHook', () => {
  it('normalizes SessionStart common fields with the payload timestamp', () => {
    const decoded = observation(
      decodeGeminiHook(loadJson('../../../../../fixtures/hooks/gemini/session-start.json'), receivedAt),
    );

    expect(decoded).toMatchObject({
      schemaVersion: 1,
      client: 'gemini-cli',
      source: 'hook',
      phase: 'session-start',
      receivedAt,
      externalSessionId: 'gemini-session-123',
      externalTurnId: null,
      externalCallId: null,
      transcriptPath: '/tmp/gemini/session-123.json',
      serverName: null,
      toolName: null,
      observedAt: '2026-07-20T01:23:45.678Z',
      durationMs: null,
      isError: null,
      inputFingerprint: null,
      correlationConfidence: 'low',
      responseTokens: null,
      loadedTokens: null,
    });
    expect(decoded.deliveryId).toMatch(/^fallback:/);
    expect(decoded.correlationKey).toMatch(/^fallback:/);
  });

  it('uses mcp_context ahead of a conflicting flattened name and discards sensitive payloads', () => {
    const payload = loadJson('../../../../../fixtures/hooks/gemini/after-tool.json');
    const decoded = observation(decodeGeminiHook(payload, receivedAt));

    expect(decoded).toMatchObject({
      phase: 'tool-after',
      serverName: 'official-server',
      toolName: 'official-tool',
      isError: false,
      observedAt: '2026-07-20T01:24:45.678Z',
    });
    const serialized = JSON.stringify(decoded);
    for (const sensitive of [
      'tool_input',
      'tool_response',
      'llmContent',
      'returnDisplay',
      'fixture-tool-input-secret',
      'fixture-llm-content-secret',
      'fixture-return-display-secret',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it('supports BeforeTool and falls back to splitFlattenedName', () => {
    const decoded = observation(
      decodeGeminiHook(
        {
          session_id: 's-before',
          transcript_path: '',
          cwd: '/tmp/project',
          hook_event_name: 'BeforeTool',
          timestamp: '2026-07-20T03:00:00.000Z',
          tool_name: 'mcp_github_list_issues',
          tool_input: { token: 'must-not-survive' },
        },
        receivedAt,
      ),
    );

    expect(decoded).toMatchObject({
      phase: 'tool-before',
      transcriptPath: null,
      serverName: 'github',
      toolName: 'list_issues',
      isError: null,
    });
    expect(JSON.stringify(decoded)).not.toContain('must-not-survive');
  });

  it('maps a non-null AfterTool error to tool-failure and null error to success', () => {
    const base = {
      session_id: 's-after',
      transcript_path: '/tmp/gemini/after.json',
      cwd: '/tmp/project',
      hook_event_name: 'AfterTool',
      timestamp: '2026-07-20T03:01:00.000Z',
      tool_name: 'mcp_git_status',
      tool_input: {},
    };

    const failed = observation(
      decodeGeminiHook(
        {
          ...base,
          tool_response: {
            llmContent: 'sensitive failure body',
            returnDisplay: 'sensitive display',
            error: { message: 'sensitive error' },
          },
        },
        receivedAt,
      ),
    );
    const succeeded = observation(
      decodeGeminiHook({ ...base, tool_response: { error: null } }, receivedAt),
    );

    expect(failed).toMatchObject({ phase: 'tool-failure', isError: true });
    expect(succeeded).toMatchObject({ phase: 'tool-after', isError: false });
    expect(JSON.stringify(failed)).not.toContain('sensitive');
  });

  it('supports SessionEnd', () => {
    const decoded = observation(
      decodeGeminiHook(
        {
          session_id: 's-end',
          transcript_path: '',
          cwd: '/tmp/project',
          hook_event_name: 'SessionEnd',
          timestamp: '2026-07-20T03:02:00.000Z',
          reason: 'exit',
        },
        receivedAt,
      ),
    );

    expect(decoded).toMatchObject({ phase: 'session-end', transcriptPath: null });
  });

  it('ignores built-in tools and unsupported hook events', () => {
    const common = {
      session_id: 's-ignore',
      transcript_path: '',
      cwd: '/tmp/project',
      timestamp: '2026-07-20T03:03:00.000Z',
    };

    expect(
      decodeGeminiHook(
        {
          ...common,
          hook_event_name: 'BeforeTool',
          tool_name: 'read_file',
          tool_input: {},
        },
        receivedAt,
      ),
    ).toEqual({ kind: 'ignored', reason: 'non-mcp-tool' });
    expect(
      decodeGeminiHook({ ...common, hook_event_name: 'BeforeModel' }, receivedAt),
    ).toEqual({ kind: 'ignored', reason: 'unsupported-phase' });
  });

  it('returns invalid results for non-objects and missing common identity fields', () => {
    expect(decodeGeminiHook(null, receivedAt)).toEqual({ kind: 'invalid', code: 'invalid-json' });
    expect(
      decodeGeminiHook(
        {
          transcript_path: '',
          hook_event_name: 'SessionStart',
          timestamp: '2026-07-20T03:04:00.000Z',
          source: 'startup',
        },
        receivedAt,
      ),
    ).toEqual({ kind: 'invalid', code: 'missing-field' });
  });
});

describe('Gemini extension assets', () => {
  it('declares a valid manifest without embedding hook registration', () => {
    const manifest = loadJson('../../../../gemini-extension/gemini-extension.json') as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: 'mcp-lens',
      version: '1.0.0',
      description: expect.any(String),
    });
    expect(manifest).not.toHaveProperty('hooks');
  });

  it('registers all passive lifecycle and tool hooks with the command-hook contract', () => {
    const config = loadJson('../../../../gemini-extension/hooks/hooks.json') as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };

    expect(Object.keys(config.hooks).sort()).toEqual(
      ['AfterTool', 'BeforeTool', 'SessionEnd', 'SessionStart'].sort(),
    );
    for (const groups of Object.values(config.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks).toHaveLength(1);
      expect(groups[0]?.hooks[0]).toMatchObject({
        type: 'command',
        command: 'node ${extensionPath}/scripts/capture.js',
        timeout: 2000,
        description: expect.stringMatching(/\{\}.*stdout.*stderr/i),
      });
    }

    const readme = readFileSync(
      new URL('../../../../gemini-extension/README.md', import.meta.url),
      'utf8',
    );
    expect(readme).toMatch(/\{\}.*stdout/i);
    expect(readme).toMatch(/stderr/i);
    expect(readme).toMatch(/local-only/i);
    expect(readme).toMatch(/tool_input.*tool_response.*llmContent.*returnDisplay/s);
  });
});
