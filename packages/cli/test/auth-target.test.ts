import { describe, it, expect } from 'vitest';
import { resolveAuthTarget } from '../src/auth-target.js';
import type { McpServerSpec } from '@mcp-lens/core';

describe('resolveAuthTarget', () => {
  const specs: McpServerSpec[] = [
    { name: 'vercel', url: 'https://vercel.example/mcp' },
    { name: 'github', command: 'gh-mcp', args: [] },
  ];

  it('http 서버는 spec을 반환한다', () => {
    const result = resolveAuthTarget(specs, 'vercel');
    expect(result).toEqual({ ok: true, spec: specs[0] });
  });

  it('이름을 찾을 수 없으면 안내 메시지와 함께 실패한다', () => {
    const result = resolveAuthTarget(specs, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('nope');
  });

  it('stdio 서버는 인증이 필요 없다는 안내와 함께 실패한다', () => {
    const result = resolveAuthTarget(specs, 'github');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('github');
  });
});
