import { describe, it, expect } from 'vitest';
import { resolveAuthTarget } from '../src/auth-target.js';
import type { McpServerSpec } from '@mcp-lens/core';

describe('resolveAuthTarget', () => {
  const specs: McpServerSpec[] = [
    { name: 'vercel', url: 'https://vercel.example/mcp' },
    { name: 'github', command: 'gh-mcp', args: [] },
  ];

  it('returns the spec for an http server', () => {
    const result = resolveAuthTarget(specs, 'vercel');
    expect(result).toEqual({ ok: true, spec: specs[0] });
  });

  it('fails with guidance when the name is not found', () => {
    const result = resolveAuthTarget(specs, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('nope');
  });

  it('fails with guidance that stdio servers need no authentication', () => {
    const result = resolveAuthTarget(specs, 'github');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('github');
  });
});
