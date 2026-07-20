import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/report.js';
import type { MatrixRow } from '@mcp-lens/core';

const row: MatrixRow = {
  serverName: 'github', toolName: 'unused', definitionTokens: 800,
  callCount: 0, responseTokens: 0, loadedSessionCount: 0, sessionCount: 10,
  recommendation: { action: 'remove', confidence: 'high',
    reason: '정의 800토큰, 호출 0회', evidenceLabel: '실측',
    evidence: { observedSessions: 12, datedObservedSessions: 12, observedDays: 20, lastCalledAt: null,
      costPerSession: 800, totalObservedCost: 9600 } },
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
        confidence: 'medium',
        reason: '3회 중 2회 실패(67%), 실패 응답 200토큰 낭비 — 점검·대체 권장',
        evidenceLabel: '전량 가정',
        evidence: { observedSessions: 10, datedObservedSessions: 10, observedDays: 20,
          lastCalledAt: '2026-07-10T00:00:00Z',
          costPerSession: 500, totalObservedCost: 5000 },
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

describe('확신 등급 표면', () => {
  const mk = (tool: string, confidence: 'high' | 'medium' | 'low'): MatrixRow => ({
    serverName: 'github', toolName: tool, definitionTokens: 800, callCount: 0,
    responseTokens: 0, loadedSessionCount: 0, sessionCount: 12,
    recommendation: { action: 'remove', confidence,
      reason: `${tool} 사유`, evidenceLabel: '전량 가정',
      evidence: { observedSessions: 12, datedObservedSessions: 12, observedDays: 20, lastCalledAt: null,
        costPerSession: 800, totalObservedCost: 9600 } },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null,
  });
  const savings = { potentialTokens: 0, actualTokens: 0, savedTokens: 0 };

  it('table 포맷에 확신 컬럼이 나온다', () => {
    const out = formatReport([mk('a', 'high')], savings, 'table');
    expect(out).toContain('확신');
    expect(out).toContain('high');
  });

  it('ai 포맷의 권고는 확신 내림차순이고 low는 후보 섹션으로 분리된다', () => {
    const out = formatReport(
      [mk('lo', 'low'), mk('hi', 'high'), mk('mid', 'medium')], savings, 'ai');
    expect(out).toContain('### 후보 (관찰 부족)');
    // 확정 권고 목록에서는 high가 medium보다 앞
    expect(out.indexOf('github/hi')).toBeLessThan(out.indexOf('github/mid'));
    // low는 후보 섹션 뒤에 온다
    expect(out.indexOf('### 후보 (관찰 부족)')).toBeLessThan(out.indexOf('github/lo'));
  });

  it('low만 있으면 확정 권고는 없다고 알린다', () => {
    const out = formatReport([mk('lo', 'low')], savings, 'ai');
    expect(out).toContain('확정 권고 없음');
    expect(out).toContain('github/lo');
  });
});
