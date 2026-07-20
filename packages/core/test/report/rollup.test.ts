// packages/core/test/report/rollup.test.ts
// rollupClient/assembleModel을 손으로 만든 MatrixRow[]/SessionMeta[]로 직접 검증한다.
// buildMatrix()는 절대 호출하지 않는다 (Task 34가 engine.ts의 reasonParts를 병행 수정 중).
import { describe, it, expect } from 'vitest';
import { rollupClient, assembleModel } from '../../src/report/rollup.js';
import type { ClientRollup } from '../../src/report/rollup.js';
import type { ClientReport, ReportTotals } from '../../src/report/model.js';
import type {
  AccountingMode, MatrixRow, Recommendation, RecommendationConfidence, SessionMeta,
} from '../../src/types.js';

function mkRow(p: {
  serverName: string;
  toolName: string;
  definitionTokens?: number | null;
  callCount?: number;
  loadedSessionCount?: number;
  responseTokens?: number;
  action?: Recommendation['action'];
  confidence?: RecommendationConfidence;
  serverBasis?: string | null;
  caveat?: string | null;
  basis?: string;
  totalObservedCost?: number | null;
  lastCalledAt?: string | null;
  errorCount?: number;
  errorRate?: number | null;
  failedResponseTokens?: number;
}): MatrixRow {
  return {
    serverName: p.serverName,
    toolName: p.toolName,
    definitionTokens: p.definitionTokens === undefined ? 100 : p.definitionTokens,
    callCount: p.callCount ?? 0,
    responseTokens: p.responseTokens ?? 0,
    loadedSessionCount: p.loadedSessionCount ?? 0,
    sessionCount: 1,
    recommendation: {
      action: p.action ?? 'keep',
      confidence: p.confidence ?? 'high',
      reason: '',
      reasonParts: {
        basis: p.basis ?? '',
        serverBasis: p.serverBasis ?? null,
        effect: null,
        caveat: p.caveat ?? null,
      },
      evidenceLabel: '실측',
      evidence: {
        observedSessions: 0,
        datedObservedSessions: 0,
        observedDays: null,
        lastCalledAt: p.lastCalledAt ?? null,
        costPerSession: null,
        totalObservedCost: p.totalObservedCost === undefined ? null : p.totalObservedCost,
      },
    },
    reliability: {
      errorCount: p.errorCount ?? 0,
      errorRate: p.errorRate ?? null,
      failedResponseTokens: p.failedResponseTokens ?? 0,
    },
    loadPattern: null,
  };
}

function mkSession(mode: AccountingMode, id = 's1'): SessionMeta {
  return { sessionId: id, client: 'claude-code', filePath: `/f/${id}`, startedAt: '2026-07-10T00:00:00Z', mode };
}

describe('rollupClient — 그룹핑', () => {
  it('같은 서버·action·confidence 툴을 한 그룹으로 묶고 perSessionTokens 합산', () => {
    const rows = [
      mkRow({ serverName: 'notion', toolName: 'a', definitionTokens: 100, action: 'remove', confidence: 'medium' }),
      mkRow({ serverName: 'notion', toolName: 'b', definitionTokens: 200, action: 'remove', confidence: 'medium' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(1);
    expect(report.buckets.act[0].perSessionTokens).toBe(300);
    expect(report.buckets.act[0].tools).toHaveLength(2);
  });

  it('다른 서버는 별도 그룹', () => {
    const rows = [
      mkRow({ serverName: 'a', toolName: 't', action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 'b', toolName: 't', action: 'remove', confidence: 'high' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(2);
  });
});

describe('rollupClient — 버킷 배정', () => {
  it('confidence low인 remove/filter-server는 candidate 버킷', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'low' }),
      mkRow({ serverName: 's', toolName: 'b', action: 'filter-server', confidence: 'low' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(0);
    expect(report.buckets.candidate).toHaveLength(2);
  });

  it('confidence high/medium인 remove/filter-server는 act 버킷', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'filter-server', confidence: 'medium' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(2);
    expect(report.buckets.candidate).toHaveLength(0);
  });

  it('inspect는 confidence 무관하게 inspect 버킷', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'inspect', confidence: 'low' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'inspect', confidence: 'high' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.inspect).toHaveLength(2);
  });

  it('keep은 healthy 버킷', () => {
    const rows = [mkRow({ serverName: 's', toolName: 'a', action: 'keep', confidence: 'high', callCount: 5 })];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.healthy).toHaveLength(1);
  });

  it('unknown은 어느 버킷에도 안 들어가고 unmeasuredToolCount로만 셈', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'unknown', confidence: 'low', definitionTokens: null }),
      mkRow({ serverName: 's', toolName: 'b', action: 'keep', confidence: 'high', callCount: 2 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(0);
    expect(report.buckets.candidate).toHaveLength(0);
    expect(report.buckets.inspect).toHaveLength(0);
    expect(report.buckets.healthy).toHaveLength(1);
    expect(report.unmeasuredToolCount).toBe(1);
  });
});

describe('rollupClient — 클라이언트 접기', () => {
  it('act·inspect 비고 candidate만 있으면 collapsed=true, collapsedSummary 채워짐', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'low', definitionTokens: 50 }),
      mkRow({ serverName: 's', toolName: 'b', action: 'filter-server', confidence: 'low', definitionTokens: 70 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.collapsed).toBe(true);
    expect(report.collapsedSummary).toEqual({ toolCount: 2, perSessionTokens: 120 });
  });

  it('act가 하나라도 있으면 collapsed=false, collapsedSummary=null', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'remove', confidence: 'low' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.collapsed).toBe(false);
    expect(report.collapsedSummary).toBeNull();
  });

  it('아무 버킷도 안 채워지면 collapsed=false (candidate가 비어있으므로)', () => {
    const rows = [mkRow({ serverName: 's', toolName: 'a', action: 'keep', confidence: 'high', callCount: 1 })];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.collapsed).toBe(false);
    expect(report.collapsedSummary).toBeNull();
  });
});

describe('rollupClient — 정렬', () => {
  it('그룹은 perSessionTokens 내림차순', () => {
    const rows = [
      mkRow({ serverName: 'small', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 10 }),
      mkRow({ serverName: 'big', toolName: 'b', action: 'remove', confidence: 'high', definitionTokens: 900 }),
      mkRow({ serverName: 'mid', toolName: 'c', action: 'remove', confidence: 'high', definitionTokens: 300 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act.map((g) => g.serverName)).toEqual(['big', 'mid', 'small']);
  });

  it('그룹 내 tools는 perSessionTokens 내림차순, null은 맨 뒤', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'low', action: 'remove', confidence: 'high', definitionTokens: 10 }),
      mkRow({ serverName: 's', toolName: 'null', action: 'remove', confidence: 'high', definitionTokens: null }),
      mkRow({ serverName: 's', toolName: 'high', action: 'remove', confidence: 'high', definitionTokens: 500 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act[0].tools.map((t) => t.toolName)).toEqual(['high', 'low', 'null']);
  });
});

describe('rollupClient — hiddenToolCount / visibleMatrixRows 연동', () => {
  it('DEFERRED 세션에서 callCount0·loadedSessionCount0 툴은 숨겨져 hiddenToolCount에 반영', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'hidden', action: 'unknown', confidence: 'low',
        definitionTokens: null, callCount: 0, loadedSessionCount: 0 }),
      mkRow({ serverName: 's', toolName: 'visible', action: 'keep', confidence: 'high', callCount: 3 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('DEFERRED_MEASURABLE')], rows);
    expect(report.hiddenToolCount).toBe(1);
    expect(report.buckets.healthy).toHaveLength(1);
  });

  it('UPFRONT 세션에서는 숨김 없음', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', callCount: 0, loadedSessionCount: 0 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.hiddenToolCount).toBe(0);
  });
});

describe('rollupClient — headline/caveat/hasUnmeasured', () => {
  it('headline = serverBasis (단일/없으면 null)', () => {
    const withBasis = rollupClient('claude-code', [mkSession('UPFRONT')], [
      mkRow({ serverName: 's', toolName: 'a', action: 'filter-server', confidence: 'high', serverBasis: '서버 s의 20툴 중 2개만 사용' }),
    ]).report;
    expect(withBasis.buckets.act[0].headline).toBe('서버 s의 20툴 중 2개만 사용');

    const noBasis = rollupClient('claude-code', [mkSession('UPFRONT')], [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', serverBasis: null }),
    ]).report;
    expect(noBasis.buckets.act[0].headline).toBeNull();
  });

  it('caveat = 그룹 내 최빈값 (동률이면 첫 등장 우선)', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'low', caveat: 'x' }),
      mkRow({ serverName: 's', toolName: 'b', action: 'remove', confidence: 'low', caveat: 'y' }),
      mkRow({ serverName: 's', toolName: 'c', action: 'remove', confidence: 'low', caveat: 'x' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.candidate[0].caveat).toBe('x');

    const tieRows = [
      mkRow({ serverName: 't', toolName: 'a', action: 'remove', confidence: 'low', caveat: 'first' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'remove', confidence: 'low', caveat: 'second' }),
    ];
    const tie = rollupClient('claude-code', [mkSession('UPFRONT')], tieRows).report;
    expect(tie.buckets.candidate[0].caveat).toBe('first');
  });

  it('hasUnmeasured = definitionTokens null 툴 존재 시 true', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 100 }),
      mkRow({ serverName: 's', toolName: 'b', action: 'remove', confidence: 'high', definitionTokens: null }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act[0].hasUnmeasured).toBe(true);
  });

  it('hasUnmeasured = false면 전부 측정됨', () => {
    const rows = [mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 100 })];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act[0].hasUnmeasured).toBe(false);
  });
});

describe('rollupClient — totals', () => {
  it('totals가 버킷별 합계와 일치', () => {
    const rows = [
      mkRow({ serverName: 's1', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 100 }),
      mkRow({ serverName: 's2', toolName: 'b', action: 'remove', confidence: 'low', definitionTokens: 50 }),
      mkRow({ serverName: 's3', toolName: 'c', action: 'inspect', confidence: 'high', failedResponseTokens: 30 }),
      mkRow({ serverName: 's4', toolName: 'd', action: 'keep', confidence: 'high', callCount: 2, responseTokens: 40 }),
    ];
    const { totals } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    const expected: ReportTotals = {
      actPerSessionTokens: 100,
      candidatePerSessionTokens: 50,
      actServerCount: 1,
      actToolCount: 1,
      candidateServerCount: 1,
      candidateToolCount: 1,
      inspectToolCount: 1,
      inspectWastedTokens: 30,
      healthyToolCount: 1,
      healthyResponseTokens: 40,
    };
    expect(totals).toEqual(expected);
  });
});

describe('assembleModel', () => {
  function mkClientReport(overrides: Partial<ClientReport>): ClientReport {
    return {
      client: 'claude-code',
      sessionCount: 1,
      collapsed: false,
      buckets: { act: [], candidate: [], inspect: [], healthy: [] },
      collapsedSummary: null,
      hiddenToolCount: 0,
      unmeasuredToolCount: 0,
      ...overrides,
    };
  }
  const zeroTotals: ReportTotals = {
    actPerSessionTokens: 0, candidatePerSessionTokens: 0, actServerCount: 0, actToolCount: 0,
    candidateServerCount: 0, candidateToolCount: 0, inspectToolCount: 0, inspectWastedTokens: 0,
    healthyToolCount: 0, healthyResponseTokens: 0,
  };

  it('클라이언트 정렬: collapsed=false 먼저, 그다음 sessionCount 내림차순', () => {
    const rollups: ClientRollup[] = [
      { report: mkClientReport({ client: 'codex', collapsed: false, sessionCount: 3 }), totals: zeroTotals },
      { report: mkClientReport({ client: 'claude-code', collapsed: true, sessionCount: 100 }), totals: zeroTotals },
      { report: mkClientReport({ client: 'gemini-cli', collapsed: false, sessionCount: 10 }), totals: zeroTotals },
    ];
    const model = assembleModel(rollups, { detail: 'full', days: 14 });
    expect(model.clients.map((c) => c.client)).toEqual(['gemini-cli', 'codex', 'claude-code']);
  });

  it('generatedAt = opts.now, days = opts.days', () => {
    const model = assembleModel([], { detail: 'full', days: 7, now: '2026-07-20T00:00:00Z' });
    expect(model.generatedAt).toBe('2026-07-20T00:00:00Z');
    expect(model.days).toBe(7);
  });

  it('totals는 클라이언트별 totals의 합', () => {
    const t1: ReportTotals = { ...zeroTotals, actPerSessionTokens: 100, actToolCount: 1 };
    const t2: ReportTotals = { ...zeroTotals, actPerSessionTokens: 50, actToolCount: 1 };
    const model = assembleModel([
      { report: mkClientReport({ client: 'claude-code' }), totals: t1 },
      { report: mkClientReport({ client: 'codex' }), totals: t2 },
    ], { detail: 'full', days: 14 });
    expect(model.totals.actPerSessionTokens).toBe(150);
    expect(model.totals.actToolCount).toBe(2);
  });
});
