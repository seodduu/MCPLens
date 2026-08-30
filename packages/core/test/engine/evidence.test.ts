// packages/core/test/engine/evidence.test.ts
import { describe, it, expect } from 'vitest';
import { buildEvidenceContext, toolEvidence, removeConfidence, inspectConfidence,
  confidencePhrase } from '../../src/engine/evidence.js';
import type { SessionMeta, ToolCallEvent, ToolDefinition, ToolLoadEvent }
  from '../../src/types.js';

const DAY = 86_400_000;
const iso = (dayOffset: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + dayOffset * DAY).toISOString();

const def = (firstScannedAt: string): ToolDefinition => ({
  serverName: 'github', toolName: 't', definitionTokens: 800,
  scannedAt: iso(30), firstScannedAt });

/** Builds n sessions one day apart (s0 = day0, s1 = day1, ...) */
const sessions = (n: number, from = 0): SessionMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `s${from + i}`, client: 'claude-code' as const,
    filePath: `/f/${from + i}`, startedAt: iso(from + i),
    mode: 'UPFRONT' as const }));

const defOf = (serverName: string, toolName: string,
  firstScannedAt: string): ToolDefinition => ({
  serverName, toolName, definitionTokens: 800, scannedAt: iso(30), firstScannedAt });

const call = (sessionId: string, serverName: string, toolName: string,
  calledAt: string | null): ToolCallEvent => ({
  sessionId, serverName, toolName, calledAt, durationMs: 1, isError: false,
  responseTokens: 10, responseText: null });

const load = (sessionId: string, serverName: string | null,
  toolName: string): ToolLoadEvent => ({ sessionId, serverName, toolName, loadedTokens: null });

const session = (id: string, startedAt: string | null): SessionMeta => ({
  sessionId: id, client: 'claude-code', filePath: `/f/${id}`, startedAt, mode: 'UPFRONT' });

describe('observation window calculation', () => {
  it('counts only sessions after the definition was first observed (no overrating a just-added server)', () => {
    // Sessions run day0 to day9; the definition was first scanned on day7 with no server activity evidence
    const ctx = buildEvidenceContext([def(iso(7))], [], [], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(3);   // only day7, day8, day9
    expect(ev.observedDays).toBe(2);       // day7 ~ day9
  });

  it('expands the window when an earlier session carries server activity (a call)', () => {
    // The definition was scanned on day7, but the day2 session called this server, so the window starts at day2
    const calls = [{ sessionId: 's2', serverName: 'github', toolName: 'other',
      calledAt: iso(2), durationMs: 1, isError: false,
      responseTokens: 10, responseText: null }];
    const ctx = buildEvidenceContext([def(iso(7))], calls, [], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(8);   // day2 ~ day9
    expect(ev.observedDays).toBe(7);
  });

  it('includes sessions with a null startedAt, since the window cannot be judged (avoids undercounting)', () => {
    const withNull: SessionMeta[] = [...sessions(3),
      { sessionId: 'sx', client: 'claude-code', filePath: '/f/x',
        startedAt: null, mode: 'UPFRONT' }];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], withNull);
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);
  });

  it('computes accumulated cost as per-session charge x observed sessions, null with no definition', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(5));
    expect(toolEvidence('github', 't', 800, ctx).totalObservedCost).toBe(4000);
    const none = toolEvidence('github', 'nodef', null, ctx);
    expect(none.costPerSession).toBeNull();
    expect(none.totalObservedCost).toBeNull();
  });

  it('takes the later of the in-window call and the all-time history for lastCalledAt', () => {
    const allTime = new Map([['github t', iso(-40)]]);
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(3), allTime);
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBe(iso(-40));
  });
});

describe('deferred-mode observation gating', () => {
  const modal = (n: number, mode: SessionMeta['mode'], from = 0): SessionMeta[] =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `s${from + i}`, client: 'claude-code' as const,
      filePath: `/f/${from + i}`, startedAt: iso(from + i), mode }));

  it('counts a deferred session only when the tool was loaded in it', () => {
    const loads = [load('s1', 'github', 't'), load('s4', 'github', 't'), load('s8', 'github', 't')];
    const ctx = buildEvidenceContext([def(iso(0))], [], loads, modal(10, 'DEFERRED_MEASURABLE'));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(3);
    expect(ev.datedObservedSessions).toBe(3);
  });

  it('grades a never-loaded tool in deferred sessions as unobserved (low confidence)', () => {
    // Another tool keeps the window alive; tool B itself was never loaded.
    const loads = [load('s0', 'github', 'other')];
    const ctx = buildEvidenceContext(
      [defOf('github', 'b', iso(0))], [], loads, modal(10, 'DEFERRED_MEASURABLE'));
    const ev = toolEvidence('github', 'b', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });

  it('keeps counting every UPFRONT session with no load events (regression)', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [], sessions(10));
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(10);
  });

  it('mixes modes: all UPFRONT sessions plus only the loaded deferred ones', () => {
    const mixed = [...sessions(5), ...modal(5, 'DEFERRED_MEASURABLE', 5)];
    const loads = [load('s6', 'github', 't'), load('s9', 'github', 't')];
    const ctx = buildEvidenceContext([def(iso(0))], [], loads, mixed);
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(7);
  });

  it('never counts DEFERRED_OPAQUE sessions, even with a load event', () => {
    const loads = [load('s2', 'github', 't')];
    const ctx = buildEvidenceContext([def(iso(0))], [], loads, modal(10, 'DEFERRED_OPAQUE'));
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(0);
  });

  it('applies the mode gate to sessions with a null startedAt too', () => {
    const withNull: SessionMeta[] = [...modal(3, 'DEFERRED_MEASURABLE'),
      { sessionId: 'sx', client: 'claude-code', filePath: '/f/x',
        startedAt: null, mode: 'DEFERRED_MEASURABLE' }];
    const loads = [load('s0', 'github', 't')];
    const ctx = buildEvidenceContext([def(iso(0))], [], loads, withNull);
    // sx has no load, so the null-startedAt inclusion rule does not rescue it
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(1);
  });
});

describe('confidence grading rules', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, datedObservedSessions: observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('grades 10 sessions, 7 days and no call history as high', () => {
    expect(removeConfidence(ev(12, 20))).toBe('high');
  });

  it('grades a well-observed tool with past call history as medium', () => {
    expect(removeConfidence(ev(12, 20, '2026-01-01T00:00:00Z'))).toBe('medium');
  });

  it('grades 5 to 9 sessions as medium', () => {
    expect(removeConfidence(ev(6, 20))).toBe('medium');
  });

  it('grades fewer than 5 sessions as low', () => {
    expect(removeConfidence(ev(3, 20))).toBe('low');
  });

  it('grades under 3 observedDays as low no matter how many sessions (the lower side wins)', () => {
    expect(removeConfidence(ev(50, 1))).toBe('low');
  });

  it('grades a null observedDays as low', () => {
    expect(removeConfidence(ev(50, null))).toBe('low');
  });

  it('grades inspect high at 10+ calls and medium at 3 to 9', () => {
    expect(inspectConfidence(10)).toBe('high');
    expect(inspectConfidence(4)).toBe('medium');
  });
});

describe('reason caveat', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, datedObservedSessions: observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('low states insufficient observation and that it is not confirmed', () => {
    const s = confidencePhrase('low', ev(2, 1));
    expect(s).toContain('not enough observation');
    expect(s).toContain('10 sessions');
    expect(s).toContain('Not a confirmed recommendation yet');
  });

  it('medium with past calls states the last call date and the lazy-loading alternative', () => {
    const s = confidencePhrase('medium', ev(12, 20, '2026-03-14T09:00:00Z'));
    expect(s).toContain('2026-03-14');
    expect(s).toContain('lazily loaded');
  });

  it('high carries observation volume, accumulated cost and how easy recovery is', () => {
    const s = confidencePhrase('high', ev(12, 20));
    expect(s).toContain('12 sessions');
    expect(s).toContain('9,600');   // 800 x 12, with thousands separator
    expect(s).toContain('Restorable');
  });

  it('medium without call history states observation volume and the need for more', () => {
    const s = confidencePhrase('medium', ev(7, 10, null));
    expect(s).toContain('7 sessions');
    expect(s).toContain('10d');
    expect(s).toContain('more observation');
    expect(s).not.toContain('last called');
  });

  it('omits the day count when observedDays is null', () => {
    expect(confidencePhrase('low', ev(2, null))).not.toMatch(/\/\d+d/);
  });
});

describe('confidence grade boundaries', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, datedObservedSessions: observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  // observedSessions boundary: <5 low, 5-9 medium, >=10 high (with enough days and no calls)
  it('grades observedSessions 4 low and 5 medium (the low gate is < 5)', () => {
    expect(removeConfidence(ev(4, 20))).toBe('low');
    expect(removeConfidence(ev(5, 20))).toBe('medium');
  });

  it('grades observedSessions 9 medium and 10 high (the high gate is >= 10)', () => {
    expect(removeConfidence(ev(9, 20))).toBe('medium');
    expect(removeConfidence(ev(10, 20))).toBe('high');
  });

  // datedObservedSessions boundary: sessions with unknown startedAt alone cannot reach high
  const dated = (observedSessions: number, datedObservedSessions: number) => ({
    observedSessions, datedObservedSessions, observedDays: 20, lastCalledAt: null,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('grades datedObservedSessions 9 medium and 10 high (observedSessions is 20 in both)', () => {
    expect(removeConfidence(dated(20, 9))).toBe('medium');
    expect(removeConfidence(dated(20, 10))).toBe('high');
  });

  // observedDays boundary: <3 low, 3-6 medium, >=7 high
  it('grades observedDays 2 low and 3 medium (the low gate is < 3)', () => {
    expect(removeConfidence(ev(50, 2))).toBe('low');
    expect(removeConfidence(ev(50, 3))).toBe('medium');
  });

  it('grades observedDays 6 medium and 7 high (the high gate is >= 7)', () => {
    expect(removeConfidence(ev(50, 6))).toBe('medium');
    expect(removeConfidence(ev(50, 7))).toBe('high');
  });

  it('grades observedDays 0 (every session on the same day) low regardless of session count', () => {
    expect(removeConfidence(ev(100, 0))).toBe('low');
  });

  it('lets the lower side win on overlapping boundaries: 4 sessions and 20 days is still low', () => {
    expect(removeConfidence(ev(4, 20))).toBe('low');
    expect(removeConfidence(ev(50, 2))).toBe('low');
  });

  it('puts the inspect boundary at 9 medium and 10 high', () => {
    expect(inspectConfidence(9)).toBe('medium');
    expect(inspectConfidence(10)).toBe('high');
  });
});

describe('activity credited from load events', () => {
  it('expands the window to a session that only has a load', () => {
    // The definition was scanned on day7, but a tool of this server was loaded in the day2 session, so the window starts at day2
    const ctx = buildEvidenceContext([def(iso(7))], [],
      [load('s2', 'github', 'other')], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(8);   // day2 ~ day9
    expect(ev.observedDays).toBe(7);
  });

  it('does not count a load with a null serverName as activity (the pre-join state)', () => {
    const ctx = buildEvidenceContext([def(iso(7))], [],
      [load('s2', null, 'other')], sessions(10));
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(3);
  });

  it('does not let a load in a session without startedAt create a window lower bound', () => {
    const ss = [session('sx', null), ...sessions(3, 1)];
    const ctx = buildEvidenceContext([], [], [load('sx', 'github', 't')], ss);
    // There is server activity, but that session's startedAt is null, so there is no lower bound and no observation is claimed
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(0);
  });
});

describe('choosing lastCalledAt', () => {
  it('uses the in-window call when it is later than the all-time history', () => {
    const allTime = new Map([['github t', iso(-40)]]);
    const ctx = buildEvidenceContext([def(iso(0))], [call('s2', 'github', 't', iso(2))],
      [], sessions(3), allTime);
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBe(iso(2));
  });

  it('keeps a call with a null calledAt out of lastCallInScope', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [call('s1', 'github', 't', null)],
      [], sessions(3));
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBeNull();
  });
});

describe('fix 1: a tool added later does not inherit the server history', () => {
  // The github server has been in use since day0 (activity evidence at day0) and its definition was first scanned on day0.
  // new_tool was added on day9, so its observation window must start at day9.
  const defs = [defOf('github', 'old_tool', iso(0)), defOf('github', 'new_tool', iso(9))];
  const calls = [call('s0', 'github', 'old_tool', iso(0))];
  const ctx = buildEvidenceContext(defs, calls, [], sessions(10));

  it('expands the window with server activity for a tool observed at the first scan', () => {
    const ev = toolEvidence('github', 'old_tool', 800, ctx);
    expect(ev.observedSessions).toBe(10);
    expect(ev.observedDays).toBe(9);
  });

  it('credits a later-added tool only from its own firstScannedAt', () => {
    const ev = toolEvidence('github', 'new_tool', 800, ctx);
    expect(ev.observedSessions).toBe(1);    // only the day9 session
    expect(ev.observedDays).toBe(0);
    expect(removeConfidence(ev)).toBe('low');
  });

  it('expands every tool with server activity when the server was first scanned today (backfill)', () => {
    // Both tools were first scanned on day9, so the server scan epoch is day9 too: neither was added later
    const first = buildEvidenceContext(
      [defOf('github', 'a', iso(9)), defOf('github', 'b', iso(9))],
      [call('s0', 'github', 'a', iso(0))], [], sessions(10));
    for (const t of ['a', 'b']) {
      const ev = toolEvidence('github', t, 800, first);
      expect(ev.observedSessions).toBe(10);
      expect(ev.observedDays).toBe(9);
    }
  });

  it('is unaffected by another server scan epoch', () => {
    const mixed = buildEvidenceContext(
      [defOf('other', 'x', iso(0)), defOf('github', 'new_tool', iso(9))],
      [call('s0', 'github', 'old', iso(0))], [], sessions(10));
    // github's epoch is day9 (its own definitions only), so new_tool counts as a first scan and expands
    expect(toolEvidence('github', 'new_tool', 800, mixed).observedSessions).toBe(10);
  });

  it('regression: a never-called tool added yesterday to a three-week-old server does not reach high', () => {
    const ss = sessions(21);   // day0 to day20, 21 sessions
    const c = buildEvidenceContext(
      [defOf('github', 'veteran', iso(0)), defOf('github', 'new_tool', iso(20))],
      [], [load('s0', 'github', 'veteran')], ss);
    const veteran = toolEvidence('github', 'veteran', 800, c);
    expect(removeConfidence(veteran)).toBe('high');           // 21 sessions, 20 days, no call history
    const fresh = toolEvidence('github', 'new_tool', 800, c);
    expect(fresh.observedSessions).toBe(1);
    expect(removeConfidence(fresh)).toBe('low');
  });
});

describe('fix 2: observedDays floors', () => {
  it('floors a 2.6-day window to 2 and keeps it low (rounding would make it 3 and medium)', () => {
    const ss = [session('s0', iso(0)), ...Array.from({ length: 9 },
      (_, i) => session(`sm${i}`, iso(0.1 * i))), session('sl', iso(2.6))];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], ss);
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(11);
    expect(ev.observedDays).toBe(2);
    expect(removeConfidence(ev)).toBe('low');
  });

  it('floors a 6.6-day window to 6 and keeps it medium (rounding would make it 7 and high)', () => {
    const ss = [...Array.from({ length: 10 }, (_, i) => session(`sm${i}`, iso(0.1 * i))),
      session('sl', iso(6.6))];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], ss);
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(11);
    expect(ev.observedDays).toBe(6);
    expect(removeConfidence(ev)).toBe('medium');
  });

  it('gives sessions within one day observedDays 0', () => {
    const ss = Array.from({ length: 12 }, (_, i) => session(`s${i}`, iso(0.05 * i)));
    const ctx = buildEvidenceContext([def(iso(0))], [], [], ss);
    expect(toolEvidence('github', 't', 800, ctx).observedDays).toBe(0);
  });
});

describe('fix 3: no window lower bound means no observation is claimed', () => {
  it('reports observedSessions 0 with neither a definition nor server activity', () => {
    const ctx = buildEvidenceContext([], [], [], sessions(50));
    const ev = toolEvidence('ghost', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    // Unknown observation means a null accumulated cost too (the UI must distinguish "0 tokens" from "unknown")
    expect(ev.totalObservedCost).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });

  it('does not count sessions with a null startedAt either when there is no lower bound', () => {
    const ctx = buildEvidenceContext([], [], [], [...sessions(3), session('sx', null)]);
    expect(toolEvidence('ghost', 't', 800, ctx).observedSessions).toBe(0);
  });

  it('keeps including sessions with a null startedAt when there is a lower bound (undercount guard stays)', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [],
      [...sessions(3), session('sx', null)]);
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);
  });

  it('creates a window from a tool own activity even with no definition (a load-only tool)', () => {
    const ctx = buildEvidenceContext([], [], [load('s5', 'github', 't')], sessions(10));
    const ev = toolEvidence('github', 't', null, ctx);
    expect(ev.observedSessions).toBe(5);   // day5 ~ day9
    expect(ev.observedDays).toBe(4);
  });
});

describe('fix 4: a tool with no definition uses its own first activity, not the server history, as the lower bound', () => {
  it('regression: a tool with no definition first loaded yesterday on an old server does not reach high', () => {
    // github has been active since day0 and only a@day0 has a definition.
    // Tool t was first loaded on day19 with no definition, so t's window must start at day19.
    const ctx = buildEvidenceContext(
      [defOf('github', 'a', iso(0))],
      [call('s0', 'github', 'a', iso(0))],
      [load('s19', 'github', 't')],
      sessions(21));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(2);    // day19, day20
    expect(ev.observedDays).toBe(1);
    expect(removeConfidence(ev)).toBe('low');
    // In the same context a veteran tool with a definition still expands with server activity
    const veteran = toolEvidence('github', 'a', 800, ctx);
    expect(veteran.observedSessions).toBe(21);
    expect(removeConfidence(veteran)).toBe('medium');   // it has call history
  });

  it('picks up the first activity of a definition-less tool from a call too', () => {
    const ctx = buildEvidenceContext([], [call('s6', 'github', 't', iso(6))],
      [load('s3', 'github', 'other')], sessions(10));
    // other on the same server was loaded on day3, but t's own first activity is day6
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);   // day6~day9
  });

  it('does not count a load with a null serverName as tool-level activity either', () => {
    const ctx = buildEvidenceContext([], [], [load('s2', null, 't')], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.totalObservedCost).toBeNull();
  });
});

describe('fix 5: when there is no session at all', () => {
  it('reports 0 observation, null days and grade low when sessions is empty', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [], []);
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(ev.lastCalledAt).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });

  it('reports a null accumulated cost when sessions is empty and there is no definition', () => {
    const ctx = buildEvidenceContext([], [], [], []);
    const ev = toolEvidence('ghost', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(ev.totalObservedCost).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });
});

describe('observedDays is null when observedSessions is 0', () => {
  it('reports 0 sessions and null days when every session precedes the window start', () => {
    const ctx = buildEvidenceContext([def(iso(20))], [], [], sessions(3));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(ev.totalObservedCost).toBe(0);
  });
});
