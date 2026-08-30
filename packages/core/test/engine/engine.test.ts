// packages/core/test/engine/engine.test.ts
import { describe, it, expect } from 'vitest';
import { buildMatrix, sessionSavings, splitByClient, dominantMode, visibleMatrixRows, joinReason } from '../../src/engine/engine.js';
import type { EngineInput } from '../../src/engine/engine.js';

const def = (tool: string, tokens: number) => ({
  serverName: 'github', toolName: tool, definitionTokens: tokens,
  scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });
const call = (tool: string) => ({
  sessionId: 's1', serverName: 'github', toolName: tool,
  calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError: false,
  responseTokens: 100, responseText: null });
const session = (mode: any) => ({
  sessionId: 's1', client: 'claude-code' as const, filePath: '/f',
  startedAt: '2026-07-10T00:00:00Z', mode });

describe('buildMatrix', () => {
  it('recommends remove for 0 calls with a definition present', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('800');   // upfront states the size
    expect(row.recommendation.evidenceLabel).toBe('assumed full load');
  });

  it('leaves a never-loaded tool unobserved in a deferred-loading session', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('unobserved');
    expect(row.recommendation.reason).toContain('never loaded');
    expect(row.recommendation.evidenceLabel).toBe('measured');
  });

  it('marks unused tools filter-server when only 2 of 40 server tools are used', () => {
    const defs = Array.from({ length: 40 }, (_, i) => def(`t${i}`, 100));
    const input: EngineInput = {
      definitions: defs, calls: [call('t0'), call('t1')], loads: [],
      sessions: [session('UPFRONT')],
    };
    const rows = buildMatrix(input);
    expect(rows.find((r) => r.toolName === 't5')!.recommendation.action).toBe('filter-server');
    expect(rows.find((r) => r.toolName === 't0')!.recommendation.action).toBe('keep');
  });
});

describe('reliability axis (design doc revision)', () => {
  const errCall = (tool: string, isError: boolean, tokens = 100) => ({
    sessionId: 's1', serverName: 'github', toolName: tool,
    calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError,
    responseTokens: tokens, responseText: null });

  it('recommends inspect for a >=50% failure rate with >=3 calls (a faulty tool)', () => {
    const input: EngineInput = {
      definitions: [def('flaky', 500)],
      calls: [errCall('flaky', true), errCall('flaky', true), errCall('flaky', false)],
      loads: [], sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('inspect');
    expect(row.reliability.errorCount).toBe(2);
    expect(row.reliability.errorRate).toBeCloseTo(2 / 3);
    expect(row.reliability.failedResponseTokens).toBe(200);
  });

  it('leaves errorRate null for an uncalled tool and keeps the existing remove verdict', () => {
    const input: EngineInput = {
      definitions: [def('unused', 800)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.reliability.errorRate).toBeNull();
    expect(row.recommendation.action).toBe('remove');
  });

  it('treats 2 failures as too small a sample: not inspect (keep stands)', () => {
    const input: EngineInput = {
      definitions: [def('rare', 300)],
      calls: [errCall('rare', true), errCall('rare', true)],
      loads: [], sessions: [session('UPFRONT')],
    };
    expect(buildMatrix(input)[0].recommendation.action).toBe('keep');
  });
});

describe('load patterns (inherited from v1)', () => {
  it('marks always-load-candidate when loaded in most sessions with calls', () => {
    const input: EngineInput = {
      definitions: [def('hot', 400)],
      calls: [call('hot')],
      loads: [
        { sessionId: 's1', serverName: 'github', toolName: 'hot', loadedTokens: null },
        { sessionId: 's2', serverName: 'github', toolName: 'hot', loadedTokens: null },
      ],
      sessions: [session('DEFERRED_MEASURABLE'),
        { ...session('DEFERRED_MEASURABLE'), sessionId: 's2' }],
    };
    expect(buildMatrix(input)[0].loadPattern).toBe('always-load-candidate');
  });

  it('marks search-pollution and says the tool is pulled in by search when loaded but never called', () => {
    const input: EngineInput = {
      definitions: [def('noise', 600)], calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'noise', loadedTokens: null }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.loadPattern).toBe('search-pollution');
    expect(row.recommendation.reason).toContain('in context in 1 of 1 sessions (1 pulled in by search)');
    expect(row.recommendation.reason).toContain('cleans up the search space');
  });
});

describe('sessionSavings', () => {
  it('makes potential the full definitions, actual the loaded part, and savings the difference', () => {
    const input: EngineInput = {
      definitions: [def('a', 500), def('b', 700)],
      calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.potentialTokens).toBe(1200);
    expect(s.actualTokens).toBe(500);  // only the loaded a, derived as 500 through the name join
    expect(s.savedTokens).toBe(700);
  });
});

describe('sessionSavings redesign (M5 + comparison set)', () => {
  it('excludes loads from unscanned servers from the actual cost (matching the comparison set)', () => {
    const input: EngineInput = {
      definitions: [def('a', 500)], // only github/a is scanned
      calls: [],
      loads: [
        { sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null },
        { sessionId: 's1', serverName: 'unscanned', toolName: 'x', loadedTokens: 9999 }, // must be excluded
      ],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.potentialTokens).toBe(500);
    expect(s.actualTokens).toBe(500);  // only a's joined value
    expect(s.savedTokens).toBe(0);
  });

  it('picks per key rather than taking a max, then sums (M5)', () => {
    const input: EngineInput = {
      definitions: [def('a', 500), def('b', 700)],
      calls: [],
      loads: [
        { sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null }, // joined: 500
        { sessionId: 's1', serverName: 'github', toolName: 'b', loadedTokens: 650 },  // direct: 650 (direct wins over the joined 700)
      ],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.actualTokens).toBe(1150); // 500 + 650, neither max(700,650) nor max(500,650)
    expect(s.savedTokens).toBe(50);    // 1200 − 1150
  });

  it('never lets savings go negative (safety net)', () => {
    const input: EngineInput = {
      definitions: [def('a', 100)],
      calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: 250 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    expect(sessionSavings(input).savedTokens).toBe(0); // max(0, 100−250)
  });
});

describe('splitByClient', () => {
  it('splits calls/loads per client while sharing definitions', () => {
    const input: EngineInput = {
      definitions: [def('shared_tool', 100)],
      calls: [
        { ...call('a'), sessionId: 'c1' },
        { ...call('b'), sessionId: 'x1' },
      ],
      loads: [{ sessionId: 'c1', serverName: 'github', toolName: 'a', loadedTokens: null }],
      sessions: [
        { ...session('DEFERRED_MEASURABLE'), sessionId: 'c1', client: 'claude-code' },
        { ...session('UPFRONT'), sessionId: 'x1', client: 'codex' },
      ],
    };
    const parts = splitByClient(input);
    expect(parts.map((p) => p.client)).toEqual(['claude-code', 'codex']);
    const claude = parts[0].input, codex = parts[1].input;
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0].toolName).toBe('a');
    expect(claude.loads).toHaveLength(1);
    expect(codex.calls[0].toolName).toBe('b');
    expect(codex.loads).toHaveLength(0);
    expect(claude.definitions).toEqual(codex.definitions); // shared
  });

  it('preserves lastCallByTool in every split, since it is common to all clients', () => {
    const lastCallByTool = new Map([['github a', '2026-03-14T09:00:00Z']]);
    const input: EngineInput = {
      definitions: [def('a', 100)],
      calls: [{ ...call('a'), sessionId: 'c1' }, { ...call('b'), sessionId: 'x1' }],
      loads: [],
      sessions: [
        { ...session('DEFERRED_MEASURABLE'), sessionId: 'c1', client: 'claude-code' },
        { ...session('UPFRONT'), sessionId: 'x1', client: 'codex' },
      ],
      lastCallByTool,
    };
    const parts = splitByClient(input);
    expect(parts).toHaveLength(2);
    for (const p of parts) expect(p.input.lastCallByTool).toBe(lastCallByTool);
  });
});

describe('M4: tools that are only loaded, with no definition or call, still get a row', () => {
  it('surfaces a load-only tool as search-pollution', () => {
    const input: EngineInput = {
      definitions: [], // a server the scanner does not cover
      calls: [],
      loads: [{ sessionId: 's1', serverName: 'unscanned', toolName: 'ghost_tool', loadedTokens: 120 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const rows = buildMatrix(input);
    const ghost = rows.find((r) => r.toolName === 'ghost_tool');
    expect(ghost).toBeDefined();
    expect(ghost!.serverName).toBe('unscanned');
    expect(ghost!.loadPattern).toBe('search-pollution');
    expect(ghost!.callCount).toBe(0);
    expect(ghost!.definitionTokens).toBeNull(); // an unavailable definition stays honestly null
  });

  it('creates no row for a load with a null serverName (code-mode search and friends)', () => {
    const input: EngineInput = {
      definitions: [], calls: [],
      loads: [{ sessionId: 's1', serverName: null, toolName: '(code-mode-search)', loadedTokens: 500 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    expect(buildMatrix(input)).toHaveLength(0);
  });
});

describe('dominantMode: OPAQUE is an absence of evidence and is excluded from the majority vote', () => {
  it('resolves OPAQUE 2 + UPFRONT 1 to UPFRONT (a real Gemini case)', () => {
    const sessions = [
      { ...session('DEFERRED_OPAQUE'), sessionId: 'g1', client: 'gemini-cli' as const },
      { ...session('DEFERRED_OPAQUE'), sessionId: 'g2', client: 'gemini-cli' as const },
      { ...session('UPFRONT'), sessionId: 'g3', client: 'gemini-cli' as const },
    ];
    expect(dominantMode(sessions)).toBe('UPFRONT');
  });
  it('resolves all-OPAQUE to OPAQUE', () => {
    expect(dominantMode([session('DEFERRED_OPAQUE')])).toBe('DEFERRED_OPAQUE');
  });
});

describe('visibleMatrixRows: the mode-aware display filter', () => {
  const rows = (mode: any) => buildMatrix({
    definitions: [def('unused', 100), def('used', 100), def('loaded_only', 100)],
    calls: [call('used')],
    loads: [{ sessionId: 's1', serverName: 'github', toolName: 'loaded_only', loadedTokens: null }],
    sessions: [session(mode)],
  });

  it('hides rows with 0 calls and 0 loads under deferred loading (zero real cost)', () => {
    const visible = visibleMatrixRows(rows('DEFERRED_MEASURABLE'),
      [session('DEFERRED_MEASURABLE')]);
    const names = visible.map((r) => r.toolName).sort();
    expect(names).toEqual(['loaded_only', 'used']); // only unused is hidden
  });

  it('shows everything under upfront (an unused definition still costs every session)', () => {
    const visible = visibleMatrixRows(rows('UPFRONT'), [session('UPFRONT')]);
    expect(visible).toHaveLength(3);
  });
});

describe('joinReason: byte-identical reasonParts -> reason (Task 34 regression)', () => {
  const RDAY = 86_400_000;
  const rat = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * RDAY).toISOString();

  // 12 sessions (day0 to day11): a window wide enough to give the notion tools high confidence
  const rsessions = Array.from({ length: 12 }, (_, i) => ({
    sessionId: `r${i}`, client: 'claude-code' as const, filePath: `/r/${i}`,
    startedAt: rat(i), mode: 'UPFRONT' as const }));

  // notion: only 1 of 10 tools (t0) used, so t1 (no pollution) and t2 (pollution) are filter-server, high confidence
  const notionDefs = Array.from({ length: 10 }, (_, i) => ({
    serverName: 'notion', toolName: `t${i}`, definitionTokens: 100,
    scannedAt: rat(0), firstScannedAt: rat(0) }));
  const notionCalls = [{
    sessionId: 'r0', serverName: 'notion', toolName: 't0',
    calledAt: rat(0), durationMs: 5, isError: false, responseTokens: 50, responseText: null }];
  const notionLoads = [{ sessionId: 'r0', serverName: 'notion', toolName: 't2', loadedTokens: null }];

  // small: 1 of 2 tools (friend) used; lonely is unused and scanned late (day11), so remove with low confidence
  const smallDefs = [
    { serverName: 'small', toolName: 'friend', definitionTokens: 80,
      scannedAt: rat(0), firstScannedAt: rat(0) },
    { serverName: 'small', toolName: 'lonely', definitionTokens: 80,
      scannedAt: rat(11), firstScannedAt: rat(11) },
  ];
  const smallCalls = [{
    sessionId: 'r11', serverName: 'small', toolName: 'friend',
    calledAt: rat(11), durationMs: 5, isError: false, responseTokens: 50, responseText: null }];

  // medserver: 1 of 2 tools (used) used; unused was scanned on day5, so remove with medium confidence
  const medDefs = [
    { serverName: 'medserver', toolName: 'used', definitionTokens: 90,
      scannedAt: rat(0), firstScannedAt: rat(0) },
    { serverName: 'medserver', toolName: 'unused', definitionTokens: 90,
      scannedAt: rat(5), firstScannedAt: rat(5) },
  ];
  const medCalls = [{
    sessionId: 'r0', serverName: 'medserver', toolName: 'used',
    calledAt: rat(0), durationMs: 5, isError: false, responseTokens: 50, responseText: null }];

  // apis: flaky called 3 times with 2 failures, so inspect
  const apiDefs = [{ serverName: 'apis', toolName: 'flaky', definitionTokens: 60,
    scannedAt: rat(0), firstScannedAt: rat(0) }];
  const apiCalls = [
    { sessionId: 'r0', serverName: 'apis', toolName: 'flaky',
      calledAt: rat(0), durationMs: 5, isError: true, responseTokens: 30, responseText: null },
    { sessionId: 'r0', serverName: 'apis', toolName: 'flaky',
      calledAt: rat(0), durationMs: 5, isError: true, responseTokens: 30, responseText: null },
    { sessionId: 'r0', serverName: 'apis', toolName: 'flaky',
      calledAt: rat(0), durationMs: 5, isError: false, responseTokens: 30, responseText: null },
  ];

  const input: EngineInput = {
    definitions: [...notionDefs, ...smallDefs, ...medDefs, ...apiDefs],
    calls: [...notionCalls, ...smallCalls, ...medCalls, ...apiCalls],
    loads: notionLoads,
    sessions: rsessions,
  };
  const rows = buildMatrix(input);

  it('produces all four actions', () => {
    const actions = new Set(rows.map((r) => r.recommendation.action));
    expect(actions).toEqual(new Set(['filter-server', 'remove', 'inspect', 'keep']));
  });

  it('keeps joinReason(reasonParts) === reason on every row (byte identical)', () => {
    for (const r of rows) {
      expect(joinReason(r.recommendation.reasonParts)).toBe(r.recommendation.reason);
    }
  });

  it('filter-server: serverBasis carries the shared server basis and never leaks into basis', () => {
    const t1 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't1')!;
    expect(t1.recommendation.action).toBe('filter-server');
    expect(t1.recommendation.reasonParts.serverBasis).toContain('Only 1 of 10 tools used');
    expect(t1.recommendation.reasonParts.basis).not.toContain('of 10 tools');
  });

  it('filter-server with pollution: the pollutionSuffix folds into effect', () => {
    const t2 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't2')!;
    expect(t2.recommendation.action).toBe('filter-server');
    expect(t2.recommendation.reasonParts.effect).toContain('pollutes the search space');
  });

  it('remove: serverBasis is null', () => {
    const lonely = rows.find((r) => r.serverName === 'small' && r.toolName === 'lonely')!;
    expect(lonely.recommendation.action).toBe('remove');
    expect(lonely.recommendation.reasonParts.serverBasis).toBeNull();
    const unused = rows.find((r) => r.serverName === 'medserver' && r.toolName === 'unused')!;
    expect(unused.recommendation.action).toBe('remove');
    expect(unused.recommendation.reasonParts.serverBasis).toBeNull();
  });

  it('lets confidence differ between remove rows (low vs medium)', () => {
    const lonely = rows.find((r) => r.serverName === 'small' && r.toolName === 'lonely')!;
    const unused = rows.find((r) => r.serverName === 'medserver' && r.toolName === 'unused')!;
    expect(lonely.recommendation.confidence).toBe('low');
    expect(unused.recommendation.confidence).toBe('medium');
  });

  it('inspect: caveat is null and basis carries the failure information', () => {
    const flaky = rows.find((r) => r.serverName === 'apis' && r.toolName === 'flaky')!;
    expect(flaky.recommendation.action).toBe('inspect');
    expect(flaky.recommendation.reasonParts.caveat).toBeNull();
    expect(flaky.recommendation.reasonParts.basis).toContain('failed');
  });

  it('keep: caveat is null', () => {
    const t0 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't0')!;
    expect(t0.recommendation.action).toBe('keep');
    expect(t0.recommendation.reasonParts.caveat).toBeNull();
  });

  it('uses no dash in any piece (global prose rule)', () => {
    for (const r of rows) {
      const p = r.recommendation.reasonParts;
      for (const part of [p.basis, p.serverBasis, p.effect, p.caveat, r.recommendation.reason]) {
        expect(part ?? '').not.toContain('—');
      }
    }
  });

  it('joins pieces with a period without doubling it', () => {
    const t1 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't1')!;
    // No ".." appears even when serverBasis already ends with a period.
    expect(t1.recommendation.reason).not.toContain('..');
    expect(t1.recommendation.reason).toContain('Tool filtering recommended. ');
  });
});

describe('number formatting in recommendation text', () => {
  const bigDef = (tool: string, tokens: number) => ({
    serverName: 'notion', toolName: tool, definitionTokens: tokens,
    scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });

  it('puts thousands separators in the definition and saved token counts', () => {
    const input: EngineInput = {
      definitions: [bigDef('huge', 12345)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.reasonParts.basis).toContain('definition 12,345 tokens');
    expect(row.recommendation.reasonParts.effect).toContain('about 12,345 tokens saved');
    expect(row.recommendation.reason).not.toMatch(/\d{5}/);
  });

  it('puts a separator in the wasted failed-response tokens too', () => {
    const failing = (n: number) => Array.from({ length: n }, () => ({
      sessionId: 's1', serverName: 'notion', toolName: 'flaky',
      calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError: true,
      responseTokens: 4000, responseText: null }));
    const input: EngineInput = {
      definitions: [bigDef('flaky', 100)], calls: failing(4), loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('inspect');
    expect(row.recommendation.reasonParts.basis).toContain('16,000 tokens wasted');
    expect(row.recommendation.reason).toContain('failed responses. inspect or replace');
  });
});

describe('confidence grade (the evidence axis)', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const sess = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const scanned = (first: string) => ({
    serverName: 'github', toolName: 'unused', definitionTokens: 800,
    scannedAt: at(0), firstScannedAt: first });

  it('gives a well-observed unused tool remove with high confidence and the accumulated cost', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(12),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.confidence).toBe('high');
    expect(row.recommendation.evidence.observedSessions).toBe(12);
    expect(row.recommendation.evidence.totalObservedCost).toBe(9600);
    expect(row.recommendation.reason).toContain('Restorable');
  });

  it('gives remove with low confidence and not-confirmed wording after only 2 observed sessions', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(2),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');   // the verdict is not demoted
    expect(row.recommendation.confidence).toBe('low');  // only the display is
    expect(row.recommendation.reason).toContain('Not a confirmed recommendation yet');
  });

  it('gives remove with medium confidence and the last call date when past calls exist outside the window', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(12),
      lastCallByTool: new Map([['github unused', '2026-03-14T09:00:00Z']]),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.confidence).toBe('medium');
    expect(row.recommendation.evidence.lastCalledAt).toBe('2026-03-14T09:00:00Z');
    expect(row.recommendation.reason).toContain('2026-03-14');
  });

  it('does not reach high on a pile of sessions with unknown startedAt (only 2 confirmed in window)', () => {
    const undatedSessions = Array.from({ length: 15 }, (_, i) => ({
      sessionId: `u${i}`, client: 'claude-code' as const, filePath: `/u/${i}`,
      startedAt: null, mode: 'UPFRONT' as const }));
    const datedSessions = [
      { sessionId: 'd0', client: 'claude-code' as const, filePath: '/d/0',
        startedAt: at(8), mode: 'UPFRONT' as const },
      { sessionId: 'd1', client: 'claude-code' as const, filePath: '/d/1',
        startedAt: at(16), mode: 'UPFRONT' as const },
    ];
    const input: EngineInput = {
      definitions: [scanned(at(8))], calls: [], loads: [],
      sessions: [...undatedSessions, ...datedSessions],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.evidence.observedSessions).toBe(17); // the count stands
    expect(row.recommendation.evidence.datedObservedSessions).toBe(2);
    expect(row.recommendation.evidence.observedDays).toBe(8);
    expect(row.recommendation.confidence).toBe('medium'); // not high
  });

  it('pins keep to high and fills evidence too', () => {
    const input: EngineInput = {
      definitions: [def('used', 300)], calls: [call('used')],
      loads: [], sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('keep');
    expect(row.recommendation.confidence).toBe('high');
    expect(row.recommendation.evidence.lastCalledAt).toBe('2026-07-10T00:00:00Z');
  });

  it('pins unknown to low', () => {
    const input: EngineInput = {
      definitions: [], calls: [],
      loads: [{ sessionId: 's1', serverName: 'unscanned', toolName: 'ghost', loadedTokens: 10 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('unknown');
    expect(row.recommendation.confidence).toBe('low');
  });

  it('grades inspect by sample size', () => {
    const errCall = (i: number) => ({
      sessionId: 's1', serverName: 'github', toolName: 'flaky',
      calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError: i % 2 === 0,
      responseTokens: 100, responseText: null });
    const many: EngineInput = {
      definitions: [def('flaky', 500)],
      calls: Array.from({ length: 12 }, (_, i) => errCall(i)),
      loads: [], sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(many);
    expect(row.recommendation.action).toBe('inspect');
    expect(row.recommendation.confidence).toBe('high');
  });
});

describe('splitByClient definition filtering', () => {
  const d = (server: string, tool: string) => ({
    serverName: server, toolName: tool, definitionTokens: 100,
    scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });
  const s = (sessionId: string, client: any) => ({
    sessionId, client, filePath: '/f', startedAt: '2026-07-10T00:00:00Z',
    mode: 'UPFRONT' as const });
  const c = (sessionId: string, server: string, tool: string) => ({
    sessionId, serverName: server, toolName: tool, calledAt: '2026-07-10T00:00:00Z',
    durationMs: null, isError: false, responseTokens: 10, responseText: null });

  const base = {
    definitions: [d('notion', 'search'), d('node_repl', 'js')],
    calls: [], loads: [],
    sessions: [s('c1', 'claude-code'), s('x1', 'codex')],
  };

  it('does not filter when serversByClient is absent (preserving legacy behaviour)', () => {
    const parts = splitByClient(base);
    for (const p of parts) expect(p.input.definitions).toHaveLength(2);
  });

  it('does not filter when serversByClient is an empty map (size 0) either (C1 regression guard)', () => {
    const parts = splitByClient({ ...base, serversByClient: new Map() });
    for (const p of parts) expect(p.input.definitions).toHaveLength(2);
  });

  it('passes only the definitions of mapped servers to that client', () => {
    const parts = splitByClient({ ...base, serversByClient: new Map([
      ['claude-code', new Set(['notion'])],
      ['codex', new Set(['node_repl'])],
    ]) });
    const claude = parts.find((p) => p.client === 'claude-code')!;
    const codex = parts.find((p) => p.client === 'codex')!;
    expect(claude.input.definitions.map((x) => x.serverName)).toEqual(['notion']);
    expect(codex.input.definitions.map((x) => x.serverName)).toEqual(['node_repl']);
  });

  it('gives a client absent from the mapping 0 definitions', () => {
    const parts = splitByClient({ ...base, serversByClient: new Map([
      ['claude-code', new Set(['notion'])],
    ]) });
    const codex = parts.find((p) => p.client === 'codex')!;
    expect(codex.input.definitions).toHaveLength(0);
  });

  it('keeps rows with call history in the matrix even when they are absent from the mapping', () => {
    const input = { ...base, calls: [c('x1', 'notion', 'search')],
      serversByClient: new Map([['codex', new Set(['node_repl'])]]) };
    const codex = splitByClient(input).find((p) => p.client === 'codex')!;
    const rows = buildMatrix(codex.input);
    expect(rows.some((r) => r.serverName === 'notion' && r.callCount === 1)).toBe(true);
  });

  it('keeps rows with load history in the matrix even when they are absent from the mapping', () => {
    const input = { ...base,
      loads: [{ sessionId: 'x1', serverName: 'notion', toolName: 'search', loadedTokens: null }],
      serversByClient: new Map([['codex', new Set(['node_repl'])]]) };
    const codex = splitByClient(input).find((p) => p.client === 'codex')!;
    const rows = buildMatrix(codex.input);
    expect(rows.some((r) => r.serverName === 'notion' && r.loadedSessionCount === 1)).toBe(true);
  });
});

describe('deferred basis (design 2026-08-31)', () => {
  const DAY = 86_400_000;
  const at = (dayOffset: number) =>
    new Date(Date.parse('2026-07-01T00:00:00Z') + dayOffset * DAY).toISOString();
  const defAt = (tool: string, tokens: number, firstScannedAt = at(0)) => ({
    serverName: 'github', toolName: tool, definitionTokens: tokens,
    scannedAt: at(9), firstScannedAt });
  const deferredSessions = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'DEFERRED_MEASURABLE' as const }));
  const upfrontSessions = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const loadIn = (sessionId: string, toolName: string) => ({
    sessionId, serverName: 'github', toolName, loadedTokens: null });

  it('never-loaded tool under deferred loading is unobserved, not remove', () => {
    const input: EngineInput = {
      definitions: [defAt('unused_tool', 800)], calls: [], loads: [],
      sessions: deferredSessions(10),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('unobserved');
    expect(row.recommendation.confidence).toBe('low');
    expect(row.recommendation.reason).toContain('never loaded in 10 sessions');
  });

  it('loaded-but-uncalled tool under deferred loading is remove graded by loaded sessions', () => {
    const input: EngineInput = {
      definitions: [defAt('polluter', 800)], calls: [],
      loads: ['s1', 's4', 's8'].map((id) => loadIn(id, 'polluter')),
      sessions: deferredSessions(10),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.confidence).toBe('low');   // 3 loaded sessions < 5
    expect(row.recommendation.evidence.observedSessions).toBe(3);
    expect(row.recommendation.reason).toContain('in context in 3 of 10 sessions (3 pulled in by search)');

    const wider: EngineInput = {
      ...input,
      loads: ['s1', 's2', 's4', 's6', 's8', 's9'].map((id) => loadIn(id, 'polluter')),
    };
    expect(buildMatrix(wider)[0].recommendation.confidence).toBe('medium');
  });

  it('a tool seen in upfront sessions but never loaded under deferred loading is remove, not unobserved', () => {
    // A mixed window: the 4 upfront sessions did put the definition in context, so there is
    // evidence even though nothing was ever pulled in by search.
    const mixed = [
      ...deferredSessions(6),
      ...Array.from({ length: 4 }, (_, i) => ({
        sessionId: `u${i}`, client: 'claude-code' as const, filePath: `/f/u${i}`,
        startedAt: at(6 + i), mode: 'UPFRONT' as const })),
    ];
    const input: EngineInput = {
      definitions: [defAt('unused_tool', 800)], calls: [], loads: [], sessions: mixed,
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.evidence.observedSessions).toBe(4);
  });

  it('upfront rule unchanged', () => {
    const input: EngineInput = {
      definitions: [defAt('unused_tool', 800)], calls: [], loads: [],
      sessions: upfrontSessions(10),
    };
    expect(buildMatrix(input)[0].recommendation.action).toBe('remove');
  });

  it('filter-server still applies under deferred loading when the server is wide', () => {
    const defs = Array.from({ length: 12 }, (_, i) => defAt(`t${i}`, 100));
    const input: EngineInput = {
      definitions: defs,
      calls: [{ sessionId: 's0', serverName: 'github', toolName: 't0',
        calledAt: at(0), durationMs: 10, isError: false,
        responseTokens: 100, responseText: null }],
      loads: [loadIn('s3', 't1')],
      sessions: deferredSessions(10),
    };
    const rows = buildMatrix(input);
    expect(rows.find((r) => r.toolName === 't1')!.recommendation.action).toBe('filter-server');
    expect(rows.find((r) => r.toolName === 't2')!.recommendation.action).toBe('unobserved');
  });
});
