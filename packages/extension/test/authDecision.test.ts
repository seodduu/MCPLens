import { describe, it, expect } from 'vitest';
import { decideAuthPrompt, friendlyAuthError, isDcrRejected } from '../src/authDecision.js';
import type { McpServerSpec } from '@mcp-lens/core';

const spec = (name: string): McpServerSpec => ({ name, url: `https://${name}.example/mcp` });

describe('decideAuthPrompt', () => {
  it('skips when no server failed', () => {
    expect(decideAuthPrompt({ failedServers: [], ignoreList: [] }))
      .toEqual({ kind: 'skip' });
  });

  it('skips when every failed server is on the ignoreList', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('linear')],
      ignoreList: ['vercel', 'linear'],
    });
    expect(d).toEqual({ kind: 'skip' });
  });

  it('prompts only for the rest when some are on the ignoreList', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('linear')],
      ignoreList: ['linear'],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel')] });
  });

  it('prompts for every newly failed server (none ignored)', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('linear')],
      ignoreList: [],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel'), spec('linear')] });
  });

  it('excludes session-snoozed servers from the prompt (Later suppresses until restart)', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('figma')],
      ignoreList: [],
      sessionSnoozed: ['figma'],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel')] });
  });

  it('skips when everything is session-snoozed', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('figma')],
      ignoreList: [],
      sessionSnoozed: ['figma'],
    });
    expect(d).toEqual({ kind: 'skip' });
  });

  it('never prompts again for an unsupported server', () => {
    const d = decideAuthPrompt({
      failedServers: [spec('vercel'), spec('figma')],
      ignoreList: [],
      unsupported: ['figma'],
    });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('vercel')] });
  });
});

describe('isDcrRejected', () => {
  it('is true for 403 Forbidden (DCR refusal)', () => {
    expect(isDcrRejected(new Error(
      'HTTP 403: Invalid OAuth error response: ... Raw body: Forbidden'))).toBe(true);
  });

  it('is true for the dynamic client registration failure wording too', () => {
    expect(isDcrRejected(new Error('dynamic client registration not supported'))).toBe(true);
  });

  it('is false for other errors such as a timeout', () => {
    expect(isDcrRejected(new Error('oauth callback timeout'))).toBe(false);
  });

  it('decides safely even for a non-Error value', () => {
    expect(isDcrRejected('boom')).toBe(false);
  });
});

describe('friendlyAuthError', () => {
  it('carries the original message for non-DCR errors', () => {
    expect(friendlyAuthError(new Error('oauth callback timeout'))).toContain('timeout');
  });

  it('handles a non-Error value safely as a string', () => {
    expect(friendlyAuthError('boom')).toContain('boom');
  });
});
