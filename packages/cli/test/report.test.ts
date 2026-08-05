import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/report.js';
import type { MatrixRow } from '@mcp-lens/core';

const row: MatrixRow = {
  serverName: 'github', toolName: 'unused', definitionTokens: 800,
  callCount: 0, responseTokens: 0, loadedSessionCount: 0, sessionCount: 10,
  recommendation: { action: 'remove', confidence: 'high',
    reason: '정의 800토큰, 호출 0회', evidenceLabel: '실측',
    reasonParts: { basis: '정의 800토큰, 호출 0회', serverBasis: null, effect: null, caveat: null },
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
        reason: '3회 중 2회 실패(67%), 실패 응답 200토큰 낭비. 점검·대체 권장',
        evidenceLabel: '전량 가정',
        reasonParts: { basis: '3회 중 2회 실패(67%), 실패 응답 200토큰 낭비',
          serverBasis: null, effect: '점검·대체 권장', caveat: null },
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

describe('ai 포맷 근거 압축', () => {
  const filterRow = (tool: string, defTokens: number, cost: number): MatrixRow => ({
    serverName: 'notion', toolName: tool, definitionTokens: defTokens, callCount: 0,
    responseTokens: 0, loadedSessionCount: 1, sessionCount: 447,
    recommendation: {
      action: 'filter-server', confidence: 'high',
      reason: '서버 notion의 27툴 중 2개만 사용. 툴 필터링 권장. 절약은 작지만 검색 공간 정리 효과. '
        + `336세션/16일 관찰, 누적 부담 ${cost.toLocaleString('en-US')}토큰. 설정 한 줄로 복구 가능`,
      reasonParts: {
        basis: '',
        serverBasis: '서버 notion의 27툴 중 2개만 사용. 툴 필터링 권장.',
        effect: '절약은 작지만 검색 공간 정리 효과',
        caveat: `336세션/16일 관찰, 누적 부담 ${cost.toLocaleString('en-US')}토큰. 설정 한 줄로 복구 가능`,
      },
      evidenceLabel: '실측',
      evidence: { observedSessions: 336, datedObservedSessions: 336, observedDays: 16,
        lastCalledAt: null, costPerSession: defTokens, totalObservedCost: cost },
    },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null,
  });
  const rows = [filterRow('a', 3411, 1146096), filterRow('b', 3376, 1134336), filterRow('c', 2543, 854448)];

  it('서버 공통 근거는 표 밖에서 서버당 한 번만 실린다', () => {
    const out = formatReport(rows, savings, 'ai');
    const occurrences = out.split('서버 notion의 27툴 중 2개만 사용').length - 1;
    expect(out).toContain('## 서버별 공통 근거');
    expect(occurrences).toBe(1);
  });

  it('되풀이되는 꼬리는 틀로 한 번만 싣고 행에는 이름과 고유 수치만 남는다', () => {
    const out = formatReport(rows, savings, 'ai');
    expect(out).toContain('## 행 근거 틀');
    expect(out).toContain('- T1: 절약은 작지만 검색 공간 정리 효과. 336세션/16일 관찰, 누적 부담 {누적}토큰. 설정 한 줄로 복구 가능');
    // 행마다 다른 누적 부담 수치는 그대로 남는다 (판정 근거이므로)
    expect(out).toContain('| T1 (누적 부담 1,146,096토큰) |');
    expect(out).toContain('| T1 (누적 부담 1,134,336토큰) |');
    expect(out).toContain('| T1 (누적 부담 854,448토큰) |');
    // 틀 정의 1회 + 표 3행 + 권고 3줄
    expect(out.split('설정 한 줄로 복구 가능').length - 1).toBe(1);
  });

  it('압축 후에도 action·확신·수치는 그대로다', () => {
    const out = formatReport(rows, savings, 'ai');
    expect(out).toContain('| notion | a | 3411 | 0 | 0 | 1/447 | - | 0 | filter-server | high |');
    expect(out).toContain('읽는 법:');
  });

  it('꼬리가 한 번만 쓰이면 틀로 빼지 않고 행에 그대로 둔다', () => {
    const out = formatReport([rows[0]], savings, 'ai');
    expect(out).not.toContain('## 행 근거 틀');
    expect(out).toContain('누적 부담 1,146,096토큰');
  });
});

describe('확신 등급 표면', () => {
  const mk = (tool: string, confidence: 'high' | 'medium' | 'low'): MatrixRow => ({
    serverName: 'github', toolName: tool, definitionTokens: 800, callCount: 0,
    responseTokens: 0, loadedSessionCount: 0, sessionCount: 12,
    recommendation: { action: 'remove', confidence,
      reason: `${tool} 사유`, evidenceLabel: '전량 가정',
      reasonParts: { basis: `${tool} 사유`, serverBasis: null, effect: null, caveat: null },
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
