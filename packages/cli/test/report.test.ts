import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/report.js';
import type { MatrixRow } from '@mcp-lens/core';

const row: MatrixRow = {
  serverName: 'github', toolName: 'unused', definitionTokens: 800,
  callCount: 0, responseTokens: 0, loadedSessionCount: 0, sessionCount: 10,
  recommendation: { action: 'remove', reason: '정의 800토큰, 호출 0회', evidenceLabel: '실측' },
};
const savings = { potentialTokens: 8000, actualTokens: 1200, savedTokens: 6800 };

describe('formatReport', () => {
  it('table 포맷은 서버/툴/권고를 포함', () => {
    const out = formatReport([row], savings, 'table');
    expect(out).toContain('github');
    expect(out).toContain('remove');
  });
  it('ai 포맷 첫 줄은 # MCP Lens Audit (플러그인 계약)', () => {
    expect(formatReport([row], savings, 'ai').split('\n')[0]).toBe('# MCP Lens Audit');
  });
  it('json 포맷은 파싱 가능', () => {
    const parsed = JSON.parse(formatReport([row], savings, 'json'));
    expect(parsed.rows).toHaveLength(1);
  });
});
