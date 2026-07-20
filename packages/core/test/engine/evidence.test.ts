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

/** n개 세션을 하루 간격으로 만든다 (s0 = day0, s1 = day1, ...) */
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
    observedSessions, datedObservedSessions: observedSessions, observedDays, lastCalledAt,
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
    observedSessions, datedObservedSessions: observedSessions, observedDays, lastCalledAt,
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

  it('호출 이력 없는 medium은 관찰량과 추가 관찰 필요를 명시한다', () => {
    const s = confidencePhrase('medium', ev(7, 10, null));
    expect(s).toContain('7세션');
    expect(s).toContain('10일');
    expect(s).toContain('추가 관찰');
    expect(s).not.toContain('마지막 호출');
  });

  it('observedDays가 null이면 일수 표기를 생략한다', () => {
    expect(confidencePhrase('low', ev(2, null))).not.toContain('일)');
  });
});

describe('확신 등급 경계값', () => {
  const ev = (observedSessions: number, observedDays: number | null,
    lastCalledAt: string | null = null) => ({
    observedSessions, datedObservedSessions: observedSessions, observedDays, lastCalledAt,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  // observedSessions 경계: <5 low, 5~9 medium, >=10 high (days 충분·호출 없음일 때)
  it('observedSessions 4 → low, 5 → medium (low 게이트는 < 5)', () => {
    expect(removeConfidence(ev(4, 20))).toBe('low');
    expect(removeConfidence(ev(5, 20))).toBe('medium');
  });

  it('observedSessions 9 → medium, 10 → high (high 게이트는 >= 10)', () => {
    expect(removeConfidence(ev(9, 20))).toBe('medium');
    expect(removeConfidence(ev(10, 20))).toBe('high');
  });

  // datedObservedSessions 경계: startedAt 미상 세션만으로는 high를 만들 수 없다
  const dated = (observedSessions: number, datedObservedSessions: number) => ({
    observedSessions, datedObservedSessions, observedDays: 20, lastCalledAt: null,
    costPerSession: 800, totalObservedCost: 800 * observedSessions });

  it('datedObservedSessions 9 → medium, 10 → high (observedSessions는 둘 다 20)', () => {
    expect(removeConfidence(dated(20, 9))).toBe('medium');
    expect(removeConfidence(dated(20, 10))).toBe('high');
  });

  // observedDays 경계: <3 low, 3~6 medium, >=7 high
  it('observedDays 2 → low, 3 → medium (low 게이트는 < 3)', () => {
    expect(removeConfidence(ev(50, 2))).toBe('low');
    expect(removeConfidence(ev(50, 3))).toBe('medium');
  });

  it('observedDays 6 → medium, 7 → high (high 게이트는 >= 7)', () => {
    expect(removeConfidence(ev(50, 6))).toBe('medium');
    expect(removeConfidence(ev(50, 7))).toBe('high');
  });

  it('observedDays 0(모든 세션이 같은 날) → 세션이 아무리 많아도 low', () => {
    expect(removeConfidence(ev(100, 0))).toBe('low');
  });

  it('경계 중첩 시 낮은 쪽이 이긴다 — 세션 4 & 일수 20도 low', () => {
    expect(removeConfidence(ev(4, 20))).toBe('low');
    expect(removeConfidence(ev(50, 2))).toBe('low');
  });

  it('inspect 경계: 9 → medium, 10 → high', () => {
    expect(inspectConfidence(9)).toBe('medium');
    expect(inspectConfidence(10)).toBe('high');
  });
});

describe('로드 이벤트 기반 활동 인정', () => {
  it('로드만 있어도 그 세션까지 창이 확장된다', () => {
    // 정의는 day7 스캔이지만 day2 세션에 이 서버 툴이 로드됐다 → 창 시작 day2
    const ctx = buildEvidenceContext([def(iso(7))], [],
      [load('s2', 'github', 'other')], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(8);   // day2 ~ day9
    expect(ev.observedDays).toBe(7);
  });

  it('serverName이 null인 로드는 활동으로 치지 않는다 (조인 전 상태)', () => {
    const ctx = buildEvidenceContext([def(iso(7))], [],
      [load('s2', null, 'other')], sessions(10));
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(3);
  });

  it('startedAt이 없는 세션의 로드는 창 하한을 만들지 못한다', () => {
    const ss = [session('sx', null), ...sessions(3, 1)];
    const ctx = buildEvidenceContext([], [], [load('sx', 'github', 't')], ss);
    // 서버 활동은 있지만 그 세션의 startedAt이 null → 창 하한 없음 → 관찰량 주장 안 함
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(0);
  });
});

describe('lastCalledAt 선택', () => {
  it('창 안 호출이 전 기간 이력보다 나중이면 창 안 호출을 쓴다', () => {
    const allTime = new Map([['github t', iso(-40)]]);
    const ctx = buildEvidenceContext([def(iso(0))], [call('s2', 'github', 't', iso(2))],
      [], sessions(3), allTime);
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBe(iso(2));
  });

  it('calledAt이 null인 호출은 lastCallInScope에 들어가지 않는다', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [call('s1', 'github', 't', null)],
      [], sessions(3));
    expect(toolEvidence('github', 't', 800, ctx).lastCalledAt).toBeNull();
  });
});

describe('수정 1 — 나중에 추가된 툴이 서버 이력을 물려받지 않는다', () => {
  // github 서버를 day0부터 써왔고(활동 증거 day0), 정의도 day0에 처음 스캔됨.
  // day9에 new_tool이 추가됨 → new_tool의 관찰 창은 day9부터여야 한다.
  const defs = [defOf('github', 'old_tool', iso(0)), defOf('github', 'new_tool', iso(9))];
  const calls = [call('s0', 'github', 'old_tool', iso(0))];
  const ctx = buildEvidenceContext(defs, calls, [], sessions(10));

  it('첫 스캔과 함께 관찰된 툴은 서버 활동으로 창이 확장된다', () => {
    const ev = toolEvidence('github', 'old_tool', 800, ctx);
    expect(ev.observedSessions).toBe(10);
    expect(ev.observedDays).toBe(9);
  });

  it('나중에 추가된 툴은 자기 firstScannedAt부터만 인정된다', () => {
    const ev = toolEvidence('github', 'new_tool', 800, ctx);
    expect(ev.observedSessions).toBe(1);    // day9 세션만
    expect(ev.observedDays).toBe(0);
    expect(removeConfidence(ev)).toBe('low');
  });

  it('서버를 오늘 처음 스캔한 경우(백필)에는 모든 툴이 서버 활동으로 확장된다', () => {
    // 두 툴 모두 day9에 처음 스캔 = 서버 scan epoch도 day9 → 나중 추가가 아님
    const first = buildEvidenceContext(
      [defOf('github', 'a', iso(9)), defOf('github', 'b', iso(9))],
      [call('s0', 'github', 'a', iso(0))], [], sessions(10));
    for (const t of ['a', 'b']) {
      const ev = toolEvidence('github', t, 800, first);
      expect(ev.observedSessions).toBe(10);
      expect(ev.observedDays).toBe(9);
    }
  });

  it('다른 서버의 scan epoch에 영향받지 않는다', () => {
    const mixed = buildEvidenceContext(
      [defOf('other', 'x', iso(0)), defOf('github', 'new_tool', iso(9))],
      [call('s0', 'github', 'old', iso(0))], [], sessions(10));
    // github의 epoch은 day9 (자기 서버 정의만) → new_tool은 "첫 스캔" → 확장됨
    expect(toolEvidence('github', 'new_tool', 800, mixed).observedSessions).toBe(10);
  });

  it('회귀: 3주 쓰던 서버에 어제 추가된 호출 0회 툴은 high가 되지 않는다', () => {
    const ss = sessions(21);   // day0 ~ day20, 21세션
    const c = buildEvidenceContext(
      [defOf('github', 'veteran', iso(0)), defOf('github', 'new_tool', iso(20))],
      [], [load('s0', 'github', 'veteran')], ss);
    const veteran = toolEvidence('github', 'veteran', 800, c);
    expect(removeConfidence(veteran)).toBe('high');           // 21세션·20일·호출 이력 없음
    const fresh = toolEvidence('github', 'new_tool', 800, c);
    expect(fresh.observedSessions).toBe(1);
    expect(removeConfidence(fresh)).toBe('low');
  });
});

describe('수정 2 — observedDays는 내림', () => {
  it('창 길이 2.6일은 2일로 내려가 low를 유지한다 (반올림이면 3일이 되어 medium)', () => {
    const ss = [session('s0', iso(0)), ...Array.from({ length: 9 },
      (_, i) => session(`sm${i}`, iso(0.1 * i))), session('sl', iso(2.6))];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], ss);
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(11);
    expect(ev.observedDays).toBe(2);
    expect(removeConfidence(ev)).toBe('low');
  });

  it('창 길이 6.6일은 6일로 내려가 medium을 유지한다 (반올림이면 7일이 되어 high)', () => {
    const ss = [...Array.from({ length: 10 }, (_, i) => session(`sm${i}`, iso(0.1 * i))),
      session('sl', iso(6.6))];
    const ctx = buildEvidenceContext([def(iso(0))], [], [], ss);
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(11);
    expect(ev.observedDays).toBe(6);
    expect(removeConfidence(ev)).toBe('medium');
  });

  it('같은 날 안의 세션들은 observedDays 0', () => {
    const ss = Array.from({ length: 12 }, (_, i) => session(`s${i}`, iso(0.05 * i)));
    const ctx = buildEvidenceContext([def(iso(0))], [], [], ss);
    expect(toolEvidence('github', 't', 800, ctx).observedDays).toBe(0);
  });
});

describe('수정 3 — 창 하한이 없으면 관찰량을 주장하지 않는다', () => {
  it('정의도 서버 활동도 없으면 observedSessions 0', () => {
    const ctx = buildEvidenceContext([], [], [], sessions(50));
    const ev = toolEvidence('ghost', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    // 관찰량 미상 → 누적 부담도 null ("0토큰"과 "모름"을 UI에서 구분해야 한다)
    expect(ev.totalObservedCost).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });

  it('창 하한이 없으면 startedAt null 세션도 계상하지 않는다', () => {
    const ctx = buildEvidenceContext([], [], [], [...sessions(3), session('sx', null)]);
    expect(toolEvidence('ghost', 't', 800, ctx).observedSessions).toBe(0);
  });

  it('창 하한이 있으면 startedAt null 세션은 계속 포함된다 (과소평가 방지 유지)', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [],
      [...sessions(3), session('sx', null)]);
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);
  });

  it('정의는 없어도 그 툴 자신의 활동이 있으면 그 시점부터 창이 생긴다 (load-only 툴)', () => {
    const ctx = buildEvidenceContext([], [], [load('s5', 'github', 't')], sessions(10));
    const ev = toolEvidence('github', 't', null, ctx);
    expect(ev.observedSessions).toBe(5);   // day5 ~ day9
    expect(ev.observedDays).toBe(4);
  });
});

describe('수정 4 — 정의 없는 툴은 서버 이력이 아니라 자기 최초 활동을 하한으로 쓴다', () => {
  it('회귀: 오래된 서버에 어제 처음 로드된 정의 미확보 툴은 high가 되지 않는다', () => {
    // github은 day0부터 활동 중이고 정의는 a@day0만 잡혀 있다.
    // 툴 t는 day19에 처음 로드됐고 정의를 못 잡았다 → t의 창은 day19부터여야 한다.
    const ctx = buildEvidenceContext(
      [defOf('github', 'a', iso(0))],
      [call('s0', 'github', 'a', iso(0))],
      [load('s19', 'github', 't')],
      sessions(21));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(2);    // day19, day20
    expect(ev.observedDays).toBe(1);
    expect(removeConfidence(ev)).toBe('low');
    // 같은 컨텍스트에서 정의가 있는 고참 툴은 여전히 서버 활동으로 확장된다
    const veteran = toolEvidence('github', 'a', 800, ctx);
    expect(veteran.observedSessions).toBe(21);
    expect(removeConfidence(veteran)).toBe('medium');   // 호출 이력 있음
  });

  it('정의 없는 툴의 최초 활동은 호출로도 잡힌다', () => {
    const ctx = buildEvidenceContext([], [call('s6', 'github', 't', iso(6))],
      [load('s3', 'github', 'other')], sessions(10));
    // 같은 서버의 other가 day3에 로드됐지만 t 자신의 최초 활동은 day6
    expect(toolEvidence('github', 't', 800, ctx).observedSessions).toBe(4);   // day6~day9
  });

  it('serverName이 null인 로드는 툴 단위 활동으로도 치지 않는다', () => {
    const ctx = buildEvidenceContext([], [], [load('s2', null, 't')], sessions(10));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.totalObservedCost).toBeNull();
  });
});

describe('수정 5 — 세션이 하나도 없을 때', () => {
  it('sessions가 비면 관찰량 0·일수 null·등급 low', () => {
    const ctx = buildEvidenceContext([def(iso(0))], [], [], []);
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(ev.lastCalledAt).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });

  it('sessions가 비고 정의도 없으면 누적 부담은 null', () => {
    const ctx = buildEvidenceContext([], [], [], []);
    const ev = toolEvidence('ghost', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(ev.totalObservedCost).toBeNull();
    expect(removeConfidence(ev)).toBe('low');
  });
});

describe('observedSessions 0이면 observedDays는 null', () => {
  it('모든 세션이 창 시작 이전이면 0세션·null일수', () => {
    const ctx = buildEvidenceContext([def(iso(20))], [], [], sessions(3));
    const ev = toolEvidence('github', 't', 800, ctx);
    expect(ev.observedSessions).toBe(0);
    expect(ev.observedDays).toBeNull();
    expect(ev.totalObservedCost).toBe(0);
  });
});
