// packages/core/test/report/instructionsAttribution.test.ts
// Saving attribution (plan docs/plans/2026-08-27-툴정의-토큰-추정기-v2-구현계획.md section 3.5):
// removing a server drops its `instructions` overhead too, filtering tools never does, not even
// when every tool of the server is filtered. Hand-written MatrixRow[]; no store, no scanner.
import { describe, it, expect } from 'vitest';
import { rollupClient } from '../../src/report/rollup.js';
import type {
  AccountingMode, MatrixRow, Recommendation, RecommendationConfidence, ServerContextOverhead,
  SessionMeta,
} from '../../src/types.js';

function mkRow(p: {
  serverName: string;
  toolName: string;
  definitionTokens: number;
  action: Recommendation['action'];
  confidence?: RecommendationConfidence;
  callCount?: number;
}): MatrixRow {
  return {
    serverName: p.serverName,
    toolName: p.toolName,
    definitionTokens: p.definitionTokens,
    callCount: p.callCount ?? 0,
    responseTokens: 0,
    loadedSessionCount: 0,
    sessionCount: 1,
    recommendation: {
      action: p.action,
      confidence: p.confidence ?? 'high',
      reason: '',
      reasonParts: { basis: '', serverBasis: null, effect: null, caveat: null },
      evidenceLabel: 'measured',
      evidence: {
        observedSessions: 0, datedObservedSessions: 0, observedDays: null,
        lastCalledAt: null, costPerSession: null, totalObservedCost: null,
      },
    },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null,
  };
}

function mkSession(mode: AccountingMode = 'UPFRONT', id = 's1'): SessionMeta {
  return { sessionId: id, client: 'claude-code', filePath: `/f/${id}`, startedAt: '2026-08-27T00:00:00Z', mode };
}

function mkOverhead(serverName: string, instructionsTokens: number): ServerContextOverhead {
  return {
    serverName,
    instructionsTokens,
    instructionsSha256: instructionsTokens > 0 ? 'a'.repeat(64) : null,
    estimatorVersion: 'v2-2026-08-27',
    scannedAt: '2026-08-27T00:00:00Z',
  };
}

/** Three tools of `docs` worth 900 tokens together, all carrying the same verdict. */
function docsRows(action: Recommendation['action']): MatrixRow[] {
  return [
    mkRow({ serverName: 'docs', toolName: 'search', definitionTokens: 400, action }),
    mkRow({ serverName: 'docs', toolName: 'fetch', definitionTokens: 300, action }),
    mkRow({ serverName: 'docs', toolName: 'list', definitionTokens: 200, action }),
  ];
}

const DOCS_INSTRUCTIONS = [mkOverhead('docs', 500)];

describe('instructions attribution', () => {
  it('server removal saving includes the instructions overhead', () => {
    const { report, totals } = rollupClient(
      'claude-code', [mkSession()], docsRows('remove'), new Set(), DOCS_INSTRUCTIONS);
    const group = report.buckets.act[0];
    expect(group.perSessionTokens).toBe(900);
    expect(group.instructionsTokens).toBe(500);
    expect(group.savingTokens).toBe(1400);
    expect(group.retainedInstructionsTokens).toBe(0);
    expect(totals.actSavingTokens).toBe(1400);
  });

  it('tool filtering saving excludes the instructions overhead', () => {
    // Two of the three tools are filtered; `list` stays because it is used. The server keeps
    // running, so its instructions keep costing.
    const rows = [
      mkRow({ serverName: 'docs', toolName: 'search', definitionTokens: 400, action: 'filter-server' }),
      mkRow({ serverName: 'docs', toolName: 'fetch', definitionTokens: 200, action: 'filter-server' }),
      mkRow({ serverName: 'docs', toolName: 'list', definitionTokens: 300, action: 'keep', callCount: 4 }),
    ];
    const { report, totals } = rollupClient(
      'claude-code', [mkSession()], rows, new Set(), DOCS_INSTRUCTIONS);
    const group = report.buckets.act[0];
    expect(group.perSessionTokens).toBe(600);
    expect(group.savingTokens).toBe(600);
    expect(group.savingTokens).not.toBe(1100);
    expect(group.instructionsTokens).toBe(500);
    expect(group.retainedInstructionsTokens).toBe(500);
    expect(totals.actSavingTokens).toBe(600);
  });

  it('filtering every tool still leaves the instructions overhead', () => {
    const filtered = rollupClient(
      'claude-code', [mkSession()], docsRows('filter-server'), new Set(), DOCS_INSTRUCTIONS);
    const removed = rollupClient(
      'claude-code', [mkSession()], docsRows('remove'), new Set(), DOCS_INSTRUCTIONS);
    const filteredGroup = filtered.report.buckets.act[0];
    const removedGroup = removed.report.buckets.act[0];
    expect(filteredGroup.perSessionTokens).toBe(900);
    expect(filteredGroup.savingTokens).toBe(900);
    // The gap between filtering everything and removing the server is exactly the instructions.
    expect(removedGroup.savingTokens - filteredGroup.savingTokens).toBe(500);
    expect(filteredGroup.retainedInstructionsTokens).toBe(500);
    expect(filtered.totals.actSavingTokens).toBe(900);
    expect(removed.totals.actSavingTokens).toBe(1400);
  });

  it('a server with no instructions has identical removal and full-filter savings', () => {
    for (const overheads of [[], [mkOverhead('docs', 0)]]) {
      const removed = rollupClient(
        'claude-code', [mkSession()], docsRows('remove'), new Set(), overheads);
      const filtered = rollupClient(
        'claude-code', [mkSession()], docsRows('filter-server'), new Set(), overheads);
      const removedGroup = removed.report.buckets.act[0];
      const filteredGroup = filtered.report.buckets.act[0];
      expect(removedGroup.savingTokens).toBe(900);
      expect(filteredGroup.savingTokens).toBe(900);
      expect(removedGroup.savingTokens).toBe(filteredGroup.savingTokens);
      expect(removedGroup.instructionsTokens).toBe(0);
      expect(removedGroup.retainedInstructionsTokens).toBe(0);
      expect(filteredGroup.retainedInstructionsTokens).toBe(0);
      expect(removed.totals.actSavingTokens).toBe(filtered.totals.actSavingTokens);
    }
  });
});
