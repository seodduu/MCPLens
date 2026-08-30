// packages/core/test/report/rollup.test.ts
// Verifies rollupClient/assembleModel directly with hand-written MatrixRow[]/SessionMeta[].
// buildMatrix() is never called (Task 34 was editing reasonParts in engine.ts in parallel).
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
      evidenceLabel: 'measured',
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

describe('rollupClient grouping', () => {
  it('groups tools sharing a server, action and confidence and sums perSessionTokens', () => {
    const rows = [
      mkRow({ serverName: 'notion', toolName: 'a', definitionTokens: 100, action: 'remove', confidence: 'medium' }),
      mkRow({ serverName: 'notion', toolName: 'b', definitionTokens: 200, action: 'remove', confidence: 'medium' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(1);
    expect(report.buckets.act[0].perSessionTokens).toBe(300);
    expect(report.buckets.act[0].tools).toHaveLength(2);
  });

  it('puts a different server in its own group', () => {
    const rows = [
      mkRow({ serverName: 'a', toolName: 't', action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 'b', toolName: 't', action: 'remove', confidence: 'high' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(2);
  });
});

describe('rollupClient bucket assignment', () => {
  it('puts low-confidence remove/filter-server in the candidate bucket', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'low' }),
      mkRow({ serverName: 's', toolName: 'b', action: 'filter-server', confidence: 'low' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(0);
    expect(report.buckets.candidate).toHaveLength(2);
  });

  it('puts high/medium-confidence remove/filter-server in the act bucket', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'filter-server', confidence: 'medium' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act).toHaveLength(2);
    expect(report.buckets.candidate).toHaveLength(0);
  });

  it('puts inspect in the inspect bucket regardless of confidence', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'inspect', confidence: 'low' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'inspect', confidence: 'high' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.inspect).toHaveLength(2);
  });

  it('puts keep in the healthy bucket', () => {
    const rows = [mkRow({ serverName: 's', toolName: 'a', action: 'keep', confidence: 'high', callCount: 5 })];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.healthy).toHaveLength(1);
  });

  it('keeps unknown out of every bucket and counts it only in unmeasuredToolCount', () => {
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

describe('rollupClient client collapsing', () => {
  it('sets collapsed=true with a filled collapsedSummary when act and inspect are empty and only candidates remain', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'low', definitionTokens: 50 }),
      mkRow({ serverName: 's', toolName: 'b', action: 'filter-server', confidence: 'low', definitionTokens: 70 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.collapsed).toBe(true);
    expect(report.collapsedSummary).toEqual({ toolCount: 2, perSessionTokens: 120 });
  });

  it('sets collapsed=false with a null collapsedSummary when there is any act', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 't', toolName: 'b', action: 'remove', confidence: 'low' }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.collapsed).toBe(false);
    expect(report.collapsedSummary).toBeNull();
  });

  it('sets collapsed=false when no bucket is filled at all (candidate is empty)', () => {
    const rows = [mkRow({ serverName: 's', toolName: 'a', action: 'keep', confidence: 'high', callCount: 1 })];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.collapsed).toBe(false);
    expect(report.collapsedSummary).toBeNull();
  });
});

describe('rollupClient ordering', () => {
  it('orders groups by perSessionTokens descending', () => {
    const rows = [
      mkRow({ serverName: 'small', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 10 }),
      mkRow({ serverName: 'big', toolName: 'b', action: 'remove', confidence: 'high', definitionTokens: 900 }),
      mkRow({ serverName: 'mid', toolName: 'c', action: 'remove', confidence: 'high', definitionTokens: 300 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act.map((g) => g.serverName)).toEqual(['big', 'mid', 'small']);
  });

  it('orders tools inside a group by perSessionTokens descending, with null last', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'low', action: 'remove', confidence: 'high', definitionTokens: 10 }),
      mkRow({ serverName: 's', toolName: 'null', action: 'remove', confidence: 'high', definitionTokens: null }),
      mkRow({ serverName: 's', toolName: 'high', action: 'remove', confidence: 'high', definitionTokens: 500 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act[0].tools.map((t) => t.toolName)).toEqual(['high', 'low', 'null']);
  });
});

describe('rollupClient hiddenToolCount / visibleMatrixRows interplay', () => {
  it('hides tools with callCount 0 and loadedSessionCount 0 in a DEFERRED session and counts them in hiddenToolCount', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'hidden', action: 'unknown', confidence: 'low',
        definitionTokens: null, callCount: 0, loadedSessionCount: 0 }),
      mkRow({ serverName: 's', toolName: 'visible', action: 'keep', confidence: 'high', callCount: 3 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('DEFERRED_MEASURABLE')], rows);
    expect(report.hiddenToolCount).toBe(1);
    expect(report.buckets.healthy).toHaveLength(1);
  });

  it('hides nothing in an UPFRONT session', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', callCount: 0, loadedSessionCount: 0 }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.hiddenToolCount).toBe(0);
  });
});

describe('rollupClient — headline/caveat/hasUnmeasured', () => {
  it('sets headline = serverBasis (null when there is none)', () => {
    const withBasis = rollupClient('claude-code', [mkSession('UPFRONT')], [
      mkRow({ serverName: 's', toolName: 'a', action: 'filter-server', confidence: 'high', serverBasis: 'Only 2 of 20 tools used on server s' }),
    ]).report;
    expect(withBasis.buckets.act[0].headline).toBe('Only 2 of 20 tools used on server s');

    const noBasis = rollupClient('claude-code', [mkSession('UPFRONT')], [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', serverBasis: null }),
    ]).report;
    expect(noBasis.buckets.act[0].headline).toBeNull();
  });

  it('sets caveat to the most common value in the group (ties go to the first occurrence)', () => {
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

  it('sets hasUnmeasured true when a tool has null definitionTokens', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 100 }),
      mkRow({ serverName: 's', toolName: 'b', action: 'remove', confidence: 'high', definitionTokens: null }),
    ];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act[0].hasUnmeasured).toBe(true);
  });

  it('sets hasUnmeasured false when everything is measured', () => {
    const rows = [mkRow({ serverName: 's', toolName: 'a', action: 'remove', confidence: 'high', definitionTokens: 100 })];
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.buckets.act[0].hasUnmeasured).toBe(false);
  });
});

describe('rollupClient — totals', () => {
  it('makes totals match the per-bucket sums', () => {
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
      // No server context overheads were passed, so the savings equal the definition sums.
      actSavingTokens: 100,
      candidateSavingTokens: 50,
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

describe('rollupClient — conflicted servers excluded from totals', () => {
  function mkRows(): MatrixRow[] {
    return [
      mkRow({ serverName: 'a', toolName: 'x', action: 'remove', confidence: 'high', definitionTokens: 100 }),
      mkRow({ serverName: 'b', toolName: 'y', action: 'remove', confidence: 'low', definitionTokens: 50 }),
    ];
  }

  it('leaves a conflicted server out of the waste totals', () => {
    const baseline = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows()).totals;
    const excluded = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows(), new Set(['b'])).totals;
    expect(excluded.candidateToolCount).toBe(baseline.candidateToolCount - 1);
    expect(excluded.candidatePerSessionTokens).toBe(baseline.candidatePerSessionTokens - 50);
  });

  it('keeps the conflicted server in the tool list', () => {
    const { report } = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows(), new Set(['b']));
    expect(report.buckets.candidate.some((g) => g.serverName === 'b')).toBe(true);
  });

  it('names the excluded servers in the model', () => {
    const rollup = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows(), new Set(['b']));
    const model = assembleModel([rollup], { detail: 'full', days: 14 });
    expect(model.conflictedServers).toEqual(['b']);
  });

  /**
   * The server count is excluded on the same basis as the tool count. Counting the server but not
   * its tools printed "1 server, 0 tools", which reads as a bug rather than as an exclusion.
   */
  it('leaves the conflicted server out of the server count too', () => {
    const baseline = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows()).totals;
    const excluded = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows(), new Set(['b'])).totals;
    expect(excluded.candidateServerCount).toBe(baseline.candidateServerCount - 1);
  });

  it('reports nothing excluded when no server conflicts', () => {
    const baselineRollup = rollupClient('claude-code', [mkSession('UPFRONT')], mkRows());
    const model = assembleModel([baselineRollup], { detail: 'full', days: 14 });
    expect(model.conflictedServers).toEqual([]);
    expect(model.totals).toEqual(baselineRollup.totals);
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
    actPerSessionTokens: 0, candidatePerSessionTokens: 0, actSavingTokens: 0,
    candidateSavingTokens: 0, actServerCount: 0, actToolCount: 0,
    candidateServerCount: 0, candidateToolCount: 0, inspectToolCount: 0, inspectWastedTokens: 0,
    healthyToolCount: 0, healthyResponseTokens: 0,
  };

  it('orders clients with collapsed=false first, then by sessionCount descending', () => {
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

  it('makes totals the sum of the per-client totals', () => {
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

describe('unobserved rows (design 2026-08-31)', () => {
  it('unobserved rows are counted, not bucketed', () => {
    const rows = [
      mkRow({ serverName: 's', toolName: 'a', definitionTokens: 100, action: 'remove', confidence: 'high' }),
      mkRow({ serverName: 's', toolName: 'b', definitionTokens: 100, callCount: 2, action: 'keep', confidence: 'high' }),
      mkRow({ serverName: 's', toolName: 'c', definitionTokens: 100, action: 'unobserved', confidence: 'low' }),
    ];
    const { report, totals } = rollupClient('claude-code', [mkSession('UPFRONT')], rows);
    expect(report.unobservedToolCount).toBe(1);
    const bucketed = [...report.buckets.act, ...report.buckets.candidate,
      ...report.buckets.inspect, ...report.buckets.healthy];
    expect(bucketed.flatMap((g) => g.tools).map((t) => t.toolName)).not.toContain('c');
    expect(totals.actToolCount).toBe(1);
    expect(totals.actPerSessionTokens).toBe(100);
    expect(totals.candidateToolCount).toBe(0);
    expect(totals.healthyToolCount).toBe(1);
  });
});
