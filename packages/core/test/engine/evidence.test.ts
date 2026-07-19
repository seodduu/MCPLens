// packages/core/test/engine/evidence.test.ts
import { describe, it, expect } from 'vitest';
import { buildEvidenceContext, toolEvidence, removeConfidence, inspectConfidence,
  confidencePhrase } from '../../src/engine/evidence.js';
import type { SessionMeta, ToolDefinition } from '../../src/types.js';

const DAY = 86_400_000;
const iso = (dayOffset: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + dayOffset * DAY).toISOString();

const def = (firstScannedAt: string): ToolDefinition => ({
  serverName: 'github', toolName: 't', definitionTokens: 800,
  scannedAt: iso(30), firstScannedAt });

/** n개 세션을 하루 간격으로 만든다 (s0 = day0, s1 = day1, ...) */
const sessions = (n: number, from = 0): SessionMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `s${from + i}`, client: 'claude-code' as const,
    filePath: `/f/${from + i}`, startedAt: iso(from + i),
    mode: 'UPFRONT' as const }));

describe('관찰 창 산정', () => {
  it('정의 최초 관찰 이후 세션만 창에 든다 (방금 추가된 서버 과대평가 방지)', () => {
    // 세션은 day0~day9, 정의는 day7에 처음 스캔됨, 서버 활동 증거 없음
    const ctx = buildEvidenceContext([def(iso(7))], [], [], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(3);   // day7, day8, day9만
    expect(ev.observedDays).toBe(2);       // day7 ~ day9
  });

  it('서버 활동(호출)이 있는 더 이른 세션이 있으면 창이 확장된다', () => {
    // 정의는 day7 스캔이지만 day2 세션에 이 서버 호출이 있었다 → 창 시작 day2
    const calls = [{ sessionId: 's2', serverName: 'github', toolName: 'other',
      calledAt: iso(2), durationMs: 1, isError: false,
      responseTokens: 10, responseText: null }];
    const ctx = buildEvidenceContext([def(iso(7))], calls, [], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(8);   // day2 ~ day9
    expect(ev.observedDays).toBe(7);
  });

  it('startedAt이 null인 세션은 창 판정 불가 → 포함한다 (과소평가 방지)', () => {
    const withNull: SessionMeta[] = [...sessions(3),
      { sessionId: 'sx', client: 'claude-code', filePath: '/f/x',
        startedAt: null, mode: 'UPFRONT' }];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], withNull);
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);
  });

  it('누적 부담 = 세션당 부담 × 관찰 세션 수, 정의 미확보면 null', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(5));
    expect(toolEvidence('github', 't', 800, ctx).totalObservedCost).toBe(4000);
    const none = toolEvidence('github', 'nodef', null, ctx);
    expect(none.costPerSession).toBeNull();
    expect(none.totalObservedCost).toBeNull();
  });

  it('lastCalledAt은 창 안 호출과 전 기간 이력 중 더 나중을 쓴다', () => {
    const allTime = new Map([['github t', iso(-40)]]);
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(3), allTime);
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBe(iso(-40));
  });
});

describe('확신 등급 규칙', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('10세션·7일·호출 이력 없음 → high', () => {
    expect(removeConfidence(ev(12, 20))).toBe('high');
  });

  it('충분히 관찰했지만 과거 호출 이력 있음 → medium', () => {
    expect(removeConfidence(ev(12, 20, '2026-01-01T00:00:00Z'))).toBe('medium');
  });

  it('5~9세션 → medium', () => {
    expect(removeConfidence(ev(6, 20))).toBe('medium');
  });

  it('5세션 미만 → low', () => {
    expect(removeConfidence(ev(3, 20))).toBe('low');
  });

  it('observedDays 3일 미만이면 세션이 많아도 low (낮은 쪽이 이긴다)', () => {
    expect(removeConfidence(ev(50, 1))).toBe('low');
  });

  it('observedDays가 null이면 low', () => {
    expect(removeConfidence(ev(50, null))).toBe('low');
  });

  it('inspect는 표본 10회 이상 high, 3~9회 medium', () => {
    expect(inspectConfidence(10)).toBe('high');
    expect(inspectConfidence(4)).toBe('medium');
  });
});

describe('reason 꼬리말', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('low는 관찰 부족과 확정 아님을 명시한다', () => {
    const s = confidencePhrase('low', ev(2, 1));
    expect(s).toContain('관찰 부족');
    expect(s).toContain('10세션');
    expect(s).toContain('확정 권고 아님');
  });

  it('과거 호출 있는 medium은 마지막 호출일과 지연 로딩 대안을 명시한다', () => {
    const s = confidencePhrase('medium', ev(12, 20, '2026-03-14T09:00:00Z'));
    expect(s).toContain('2026-03-14');
    expect(s).toContain('지연 로딩');
  });

  it('high는 관찰량·누적 부담·복구 용이함을 담는다', () => {
    const s = confidencePhrase('high', ev(12, 20));
    expect(s).toContain('12세션');
    expect(s).toContain('9600');   // 800 × 12
    expect(s).toContain('복구');
  });
});
