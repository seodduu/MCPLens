// packages/core/test/report/markdown.test.ts
// renderReport(ReportModel -> markdown) regression tests.
// The ReportModel here is a hand-written fixture; aggregation (buildReport) is covered elsewhere.
import { describe, it, expect } from 'vitest';
import { renderReport } from '../../src/report/markdown.js';
import type {
  ReportModel,
  ReportOptions,
  ReportTotals,
  ClientReport,
  ReportGroup,
  ReportTool,
  ReportBucket,
} from '../../src/report/model.js';

const OPTS: ReportOptions = { detail: 'full', days: 30, now: '2026-07-20T00:00:00.000Z' };
const SUMMARY_OPTS: ReportOptions = { ...OPTS, detail: 'summary' };

function tool(over: Partial<ReportTool> = {}): ReportTool {
  return {
    toolName: 'tool',
    perSessionTokens: 100,
    totalObservedCost: 100,
    callCount: 0,
    errorCount: 0,
    errorRate: null,
    responseTokens: 0,
    lastCalledAt: null,
    note: null,
    ...over,
  };
}

function group(over: Partial<ReportGroup> = {}): ReportGroup {
  return {
    serverName: 'server',
    action: 'remove',
    confidence: 'high',
    headline: null,
    caveat: null,
    perSessionTokens: 100,
    totalObservedCost: 100,
    hasUnmeasured: false,
    tools: [tool()],
    ...over,
  };
}

function emptyBuckets(): Record<ReportBucket, ReportGroup[]> {
  return { act: [], candidate: [], inspect: [], healthy: [] };
}

function client(over: Partial<ClientReport> = {}): ClientReport {
  return {
    client: 'claude-code',
    sessionCount: 159,
    collapsed: false,
    buckets: emptyBuckets(),
    collapsedSummary: null,
    hiddenToolCount: 0,
    unmeasuredToolCount: 0,
    ...over,
  };
}

function totals(over: Partial<ReportTotals> = {}): ReportTotals {
  return {
    actPerSessionTokens: 0,
    candidatePerSessionTokens: 0,
    actServerCount: 0,
    actToolCount: 0,
    candidateServerCount: 0,
    candidateToolCount: 0,
    inspectToolCount: 0,
    inspectWastedTokens: 0,
    healthyToolCount: 0,
    healthyResponseTokens: 0,
    ...over,
  };
}

function model(over: Partial<ReportModel> = {}): ReportModel {
  return {
    generatedAt: '2026-07-20T00:00:00.000Z',
    days: 30,
    clients: [],
    totals: totals(),
    ...over,
  };
}

describe('renderReport - headline and summary table', () => {
  it('shows both the act total and the candidate total in the headline', () => {
    const out = renderReport(
      model({ totals: totals({ actPerSessionTokens: 3500, candidatePerSessionTokens: 15867 }) }),
      OPTS,
    );
    expect(out).toContain('3,500tok per session');
    expect(out).toContain('15,867tok');
  });

  it('adds thousands separators (values under 1000 stay as-is)', () => {
    const out = renderReport(
      model({
        clients: [
          client({
            buckets: {
              ...emptyBuckets(),
              act: [
                group({
                  serverName: 'demo-bigsuite',
                  caveat: 'accumulated cost 286,200tok · restorable with one config line',
                  perSessionTokens: 800,
                }),
              ],
            },
          }),
        ],
        totals: totals({ actPerSessionTokens: 800, actServerCount: 1, actToolCount: 1 }),
      }),
      OPTS,
    );
    expect(out).toContain('286,200tok');
    expect(out).toContain('800tok');
  });

  it('renders the four summary rows with category, scope and per-session columns', () => {
    const out = renderReport(
      model({
        totals: totals({
          actPerSessionTokens: 3500, actServerCount: 2, actToolCount: 11,
          candidatePerSessionTokens: 15867, candidateServerCount: 2, candidateToolCount: 11,
          inspectToolCount: 3, inspectWastedTokens: 1020,
          healthyToolCount: 21,
        }),
      }),
      OPTS,
    );
    expect(out).toContain('| ✅ Act now | 2 servers · 11 tools | **3,500tok** |');
    expect(out).toContain('| ⏳ Needs more observation | 2 servers · 11 tools | 15,867tok (unconfirmed) |');
    expect(out).toContain('| 🔧 Needs inspection | 3 tools | 1,020tok wasted on failed responses |');
    expect(out).toContain('| 👍 In healthy use | 21 tools | — |');
  });

  it('takes the date from the first 10 characters of opts.now', () => {
    const out = renderReport(model(), { ...OPTS, now: '2026-07-20T12:34:56.000Z', days: 30 });
    expect(out).toContain('# MCP Lens · last 30 days (as of 2026-07-20)');
  });

  it('says so when there is nothing to act on', () => {
    const out = renderReport(model(), OPTS);
    expect(out).toContain('Nothing needs action right now');
  });
});

describe('renderReport - client sections', () => {
  it('renders the client header as "## {client} · {n} sessions"', () => {
    const out = renderReport(model({ clients: [client({ client: 'codex', sessionCount: 94 })] }), OPTS);
    expect(out).toContain('## codex · 94 sessions');
  });

  it('omits titles for empty buckets', () => {
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), healthy: [group()] } })] }),
      OPTS,
    );
    expect(out).not.toContain('### ✅ Act now');
    expect(out).not.toContain('### ⏳ Needs more observation');
    expect(out).not.toContain('### 🔧 Needs inspection');
    expect(out).toContain('In healthy use');
  });

  it('puts a --- divider between clients', () => {
    const out = renderReport(
      model({ clients: [client({ client: 'claude-code' }), client({ client: 'codex' })] }),
      OPTS,
    );
    expect(out).toContain('---');
  });
});

describe('renderReport - act bucket', () => {
  it('renders the shared server basis once in the group headline (homogeneous tools collapse to a blockquote)', () => {
    const manyTools = Array.from({ length: 9 }, (_, i) => tool({ toolName: `tool_${i + 1}`, perSessionTokens: 200 }));
    const g = group({
      serverName: 'demo-bigsuite',
      action: 'filter-server',
      headline: 'only `ping` used out of 10 tools',
      caveat: '159 sessions/29d observed · accumulated cost 286,200tok · restorable with one config line',
      perSessionTokens: 1800,
      tools: manyTools,
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      OPTS,
    );
    expect(out.match(/only `ping` used out of 10 tools/g)).toHaveLength(1);
    expect(out).toContain('1,800tok/session');
    expect(out).toContain('tool_1');
    expect(out).toContain('tool_9');
  });

  it('titles the act bucket with the sum of group perSessionTokens', () => {
    const g1 = group({ serverName: 's1', perSessionTokens: 1800, tools: [tool({ perSessionTokens: 1800 })] });
    const g2 = group({ serverName: 's2', perSessionTokens: 1700, tools: [tool({ perSessionTokens: 1700 })] });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g1, g2] } })] }),
      OPTS,
    );
    expect(out).toContain('### ✅ Act now: 3,500tok/session');
  });

  it('never truncates act groups, even in summary mode', () => {
    const manyTools = Array.from({ length: 9 }, (_, i) => tool({ toolName: `tool_${i + 1}`, perSessionTokens: 200 }));
    const g = group({ serverName: 'demo-bigsuite', headline: '9 unused', tools: manyTools });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      { ...OPTS, detail: 'summary' },
    );
    expect(out).not.toMatch(/\+\d+ more/);
    expect(out).toContain('tool_1');
    expect(out).toContain('tool_9');
  });

  it('renders act groups without a headline as a per-tool table', () => {
    const g = group({
      serverName: 'demo-github',
      headline: null,
      perSessionTokens: 1700,
      tools: [
        tool({ toolName: 'list_issues', perSessionTokens: 800, lastCalledAt: null }),
        tool({ toolName: 'search_code', perSessionTokens: 900, lastCalledAt: '2026-05-21', note: 'may be a low-frequency tool, consider keeping it lazily loaded' }),
      ],
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('| Tool | Per session | Last call | Observed |');
    expect(out).toContain('list_issues');
    expect(out).toContain('800tok');
    expect(out).toContain('search_code');
    expect(out).toContain('may be a low-frequency tool, consider keeping it lazily loaded');
  });
});

describe('renderReport - candidate bucket', () => {
  it('truncates candidate group tools to 5 in summary mode', () => {
    const manyTools = Array.from({ length: 14 }, (_, i) => tool({ toolName: `t${i}`, perSessionTokens: 100 }));
    const g = group({ serverName: 'notion', headline: 'only 2 of 20 tools used', tools: manyTools, perSessionTokens: 1400 });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      { ...OPTS, detail: 'summary' },
    );
    expect(out).toContain('+9 more');
  });

  it('does not truncate in full mode', () => {
    const manyTools = Array.from({ length: 14 }, (_, i) => tool({ toolName: `t${i}`, perSessionTokens: 100 }));
    const g = group({ serverName: 'notion', headline: 'only 2 of 20 tools used', tools: manyTools, perSessionTokens: 1400 });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      { ...OPTS, detail: 'full' },
    );
    expect(out).not.toMatch(/\+\d+ more/);
    expect(out).toContain('t13');
  });

  it('renders a single-tool candidate group as one line', () => {
    const g = group({
      serverName: 'demo-github',
      headline: null,
      tools: [tool({ toolName: 'create_gist', perSessionTokens: 600 })],
      perSessionTokens: 600,
    });
    const out = renderReport(
      model({ clients: [client({ sessionCount: 19, buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('**demo-github/create_gist**');
    expect(out).toContain('600tok');
  });

  it('mentions the need for more observation in the candidate bucket title', () => {
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [group()] } })] }),
      OPTS,
    );
    expect(out).toContain('### ⏳ Needs more observation: not a recommendation yet');
    // The blocking axis may not be session count at all (observed days, past call history).
    // Claiming a specific threshold would print "10 sessions needed" to a 148-session client.
    expect(out).not.toMatch(/10 sessions/);
  });

  it('shows a single candidate tool with null perSessionTokens as unmeasured, not 0tok', () => {
    const g = group({
      serverName: 'demo-github',
      headline: null,
      tools: [tool({ toolName: 'unscanned_tool', perSessionTokens: null })],
      perSessionTokens: 0,
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('demo-github/unscanned_tool** · unmeasured');
    expect(out).not.toContain('unscanned_tool** · 0tok');
  });

  it('shows unmeasured tools inside a mixed candidate group as unmeasured, not 0tok', () => {
    const g = group({
      serverName: 'notion',
      headline: 'only 2 of 20 tools used',
      hasUnmeasured: true,
      tools: [
        tool({ toolName: 'measured', perSessionTokens: 300 }),
        tool({ toolName: 'unscanned', perSessionTokens: null }),
      ],
      perSessionTokens: 300,
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('unscanned unmeasured');
    expect(out).not.toMatch(/unscanned 0tok/);
  });

  it('marks a candidate group with hasUnmeasured=true as partly unmeasured', () => {
    const g = group({
      serverName: 'notion',
      headline: 'only 2 of 20 tools used',
      hasUnmeasured: true,
      tools: [tool({ toolName: 'a', perSessionTokens: 100 }), tool({ toolName: 'b', perSessionTokens: null })],
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('partly unmeasured');
  });
});

describe('renderReport - inspect / healthy buckets', () => {
  it('renders a failure-rate and waste table for the inspect bucket', () => {
    const g = group({
      serverName: 'demo-github',
      action: 'inspect',
      tools: [
        tool({ toolName: 'flaky_search', callCount: 15, errorCount: 9, errorRate: 0.6, responseTokens: 90 }),
      ],
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), inspect: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('### 🔧 Needs inspection: frequently failing tools');
    expect(out).toContain('| Tool | Failures | Wasted |');
    expect(out).toContain('demo-github/flaky_search');
    expect(out).toContain('9 of 15 (60%)');
  });

  it('gives the healthy bucket an "N tools · Ntok responses" title and a one-line summary', () => {
    const g = group({
      serverName: 'demo-github',
      action: 'keep',
      tools: [tool({ toolName: 'get_file', callCount: 30, responseTokens: 500 })],
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), healthy: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('### 👍 In healthy use: 1 tool · 500tok responses');
    expect(out).toContain('demo-github/get_file 30 calls');
  });

  it('truncates healthy groups over 6 tools down to 5 in summary mode and appends …', () => {
    const manyTools = Array.from({ length: 9 }, (_, i) => tool({ toolName: `h${i}`, callCount: 1 }));
    const g = group({ serverName: 'demo-github', action: 'keep', tools: manyTools });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), healthy: [g] } })] }),
      { ...OPTS, detail: 'summary' },
    );
    expect(out).toContain('h0');
    expect(out).toContain('h4');
    expect(out).not.toContain('h5');
    expect(out).toContain('…');
  });
});

describe('renderReport - collapsed clients', () => {
  it('keeps a collapsed client to at most 3 lines', () => {
    const out = renderReport(
      model({
        clients: [
          client({
            client: 'gemini-cli',
            sessionCount: 3,
            collapsed: true,
            collapsedSummary: { toolCount: 7, perSessionTokens: 1200 },
          }),
        ],
      }),
      SUMMARY_OPTS,
    );
    const section = out.split('## gemini-cli')[1];
    expect(section.trim().split('\n').filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(section).toContain('Not enough observation yet');
    expect(section).toContain('7 unused definitions');
    expect(section).toContain('3 sessions observed');
    // Never claim a session threshold; the unmet condition may be observed days instead.
    expect(section).not.toMatch(/10 sessions/);
  });

  it('claims no session threshold even for a collapsed client with many sessions', () => {
    // Real-data regression: claude-code with 148 sessions collapsed to all-low because
    // observedDays=0, yet the report told the user to "use it for 10+ sessions".
    const out = renderReport(
      model({
        clients: [
          client({
            client: 'claude-code',
            sessionCount: 148,
            collapsed: true,
            collapsedSummary: { toolCount: 10, perSessionTokens: 15267 },
          }),
        ],
      }),
      SUMMARY_OPTS,
    );
    const section = out.split('## claude-code')[1];
    expect(section).not.toMatch(/10 sessions/);
    expect(section).toContain('148 sessions observed');
  });
});

describe('renderReport - footnotes', () => {
  it('emits the deferred-loading footnote when hiddenToolCount>0', () => {
    const out = renderReport(
      model({ clients: [client({ hiddenToolCount: 78, buckets: { ...emptyBuckets(), healthy: [group()] } })] }),
      OPTS,
    );
    expect(out).toContain('Deferred loading');
    expect(out).toContain('78 tools');
  });

  it('emits no footnote when hiddenToolCount=0', () => {
    const out = renderReport(
      model({ clients: [client({ hiddenToolCount: 0, buckets: { ...emptyBuckets(), healthy: [group()] } })] }),
      OPTS,
    );
    expect(out).not.toContain('Deferred loading');
  });

  it('emits the unmeasured footnote when unmeasuredToolCount>0', () => {
    const out = renderReport(
      model({
        clients: [
          client({ unmeasuredToolCount: 4, buckets: { ...emptyBuckets(), healthy: [group()] } }),
        ],
      }),
      OPTS,
    );
    expect(out).toContain('4 tools');
    expect(out).toMatch(/no definition tokens/);
  });

  it('emits no unmeasured footnote when unmeasuredToolCount=0', () => {
    const out = renderReport(
      model({
        clients: [
          client({ unmeasuredToolCount: 0, buckets: { ...emptyBuckets(), healthy: [group()] } }),
        ],
      }),
      OPTS,
    );
    expect(out).not.toContain('no definition tokens');
  });
});

describe('renderReport - display policy', () => {
  it('uses no HTML tags', () => {
    const g = group({ tools: [tool()] });
    const out = renderReport(
      model({
        clients: [
          client({
            buckets: {
              act: [g],
              candidate: [group({ serverName: 's2' })],
              inspect: [group({ serverName: 's3', action: 'inspect' })],
              healthy: [group({ serverName: 's4', action: 'keep' })],
            },
          }),
        ],
      }),
      OPTS,
    );
    expect(out).not.toMatch(/<details|<summary|<div/i);
  });

  it('always labels definition tokens as per-session (distinct from accumulated)', () => {
    const g = group({ serverName: 'demo-bigsuite', headline: 'h', perSessionTokens: 1800, totalObservedCost: 286200, tools: [tool()] });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('1,800tok/session');
  });
});
