import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/report.js';
import type { MatrixRow } from '@mcp-lens/core';

const row: MatrixRow = {
  serverName: 'github', toolName: 'unused', definitionTokens: 800,
  callCount: 0, responseTokens: 0, loadedSessionCount: 0, sessionCount: 10,
  recommendation: { action: 'remove', reason: '정의 800토큰, 호출 0회', evidenceLabel: '실측' },
  reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
  loadPattern: null,
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
  it('ai 포맷은 inspect 행을 불량 툴 점검 권고 섹션에 포함', () => {
    const flakyRow: MatrixRow = {
      serverName: 'github', toolName: 'flaky', definitionTokens: 500,
      callCount: 3, responseTokens: 300, loadedSessionCount: 0, sessionCount: 10,
      recommendation: {
        action: 'inspect',
        reason: '3회 중 2회 실패(67%), 실패 응답 200토큰 낭비 — 점검·대체 권장',
        evidenceLabel: '전량 가정',
      },
      reliability: { errorCount: 2, errorRate: 2 / 3, failedResponseTokens: 200 },
      loadPattern: null,
    };
    const out = formatReport([row, flakyRow], savings, 'ai');
    expect(out).toContain('## 불량 툴 점검 권고');
    expect(out).toContain('github/flaky');
    expect(out).toContain('inspect');
  });
});
