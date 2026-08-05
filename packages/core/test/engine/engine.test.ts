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
  it('호출 0회 + 정의 있음 → remove 권고', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('800');   // 업프론트 → 크기 명시
    expect(row.recommendation.evidenceLabel).toBe('전량 가정');
  });

  it('지연 로딩 세션에서는 같은 판정, 다른 표기', () => {
    const input: EngineInput = {
      definitions: [def('unused_tool', 800)], calls: [], loads: [],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.reason).toContain('검색 공간');
    expect(row.recommendation.evidenceLabel).toBe('실측');
  });

  it('서버 40툴 중 2개만 사용 → 미사용 툴은 filter-server', () => {
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

describe('신뢰도 축 (설계문서 개정)', () => {
  const errCall = (tool: string, isError: boolean, tokens = 100) => ({
    sessionId: 's1', serverName: 'github', toolName: tool,
    calledAt: '2026-07-10T00:00:00Z', durationMs: 10, isError,
    responseTokens: tokens, responseText: null });

  it('실패율 50% 이상 + 3회 이상 호출 → inspect (불량 툴)', () => {
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

  it('호출 0회 툴의 errorRate는 null, 판정은 기존 remove 유지', () => {
    const input: EngineInput = {
      definitions: [def('unused', 800)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.reliability.errorRate).toBeNull();
    expect(row.recommendation.action).toBe('remove');
  });

  it('2회 실패는 표본 부족 → inspect 아님 (keep 유지)', () => {
    const input: EngineInput = {
      definitions: [def('rare', 300)],
      calls: [errCall('rare', true), errCall('rare', true)],
      loads: [], sessions: [session('UPFRONT')],
    };
    expect(buildMatrix(input)[0].recommendation.action).toBe('keep');
  });
});

describe('로드 패턴 (v1 계승)', () => {
  it('과반 세션에서 로드 + 호출 있음 → always-load-candidate', () => {
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

  it('로드되나 호출 0회 → search-pollution + reason에 오염 표기', () => {
    const input: EngineInput = {
      definitions: [def('noise', 600)], calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'noise', loadedTokens: null }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.loadPattern).toBe('search-pollution');
    expect(row.recommendation.reason).toContain('검색 공간 오염');
  });
});

describe('sessionSavings', () => {
  it('잠재 = 정의 전량, 실비용 = 로드분, 절감 = 차이', () => {
    const input: EngineInput = {
      definitions: [def('a', 500), def('b', 700)],
      calls: [],
      loads: [{ sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.potentialTokens).toBe(1200);
    expect(s.actualTokens).toBe(500);  // 로드된 a만 — 이름 조인으로 500 산출
    expect(s.savedTokens).toBe(700);
  });
});

describe('sessionSavings 재설계 (M5 + 비교집합)', () => {
  it('스캔 안 된 서버의 로드는 실비용에서 제외한다 (비교집합 일치)', () => {
    const input: EngineInput = {
      definitions: [def('a', 500)], // github/a만 스캔됨
      calls: [],
      loads: [
        { sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null },
        { sessionId: 's1', serverName: 'unscanned', toolName: 'x', loadedTokens: 9999 }, // 제외돼야
      ],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.potentialTokens).toBe(500);
    expect(s.actualTokens).toBe(500);  // a의 조인값만
    expect(s.savedTokens).toBe(0);
  });

  it('조인 기반과 직접 기록은 max가 아니라 키 단위로 택일해 합산한다 (M5)', () => {
    const input: EngineInput = {
      definitions: [def('a', 500), def('b', 700)],
      calls: [],
      loads: [
        { sessionId: 's1', serverName: 'github', toolName: 'a', loadedTokens: null }, // 조인 → 500
        { sessionId: 's1', serverName: 'github', toolName: 'b', loadedTokens: 650 },  // 직접 → 650 (조인 700보다 직접 우선)
      ],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const s = sessionSavings(input);
    expect(s.actualTokens).toBe(1150); // 500 + 650 — max(700,650)도 max(500,650)도 아님
    expect(s.savedTokens).toBe(50);    // 1200 − 1150
  });

  it('절감은 음수가 되지 않는다 (안전망)', () => {
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
  it('세션의 클라이언트별로 calls/loads가 분할되고 definitions는 공유된다', () => {
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
    expect(claude.definitions).toEqual(codex.definitions); // 공유
  });

  it('lastCallByTool은 전 클라이언트 공통이므로 각 분할에 그대로 보존된다', () => {
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

describe('M4: 로드만 되고 정의·호출이 없는 툴도 행이 생긴다', () => {
  it('load-only 툴이 search-pollution으로 표면화된다', () => {
    const input: EngineInput = {
      definitions: [], // 스캐너 미커버 서버
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
    expect(ghost!.definitionTokens).toBeNull(); // 정의 미확보는 그대로 정직하게
  });

  it('serverName이 null인 로드(코드모드 검색 등)는 행을 만들지 않는다', () => {
    const input: EngineInput = {
      definitions: [], calls: [],
      loads: [{ sessionId: 's1', serverName: null, toolName: '(code-mode-search)', loadedTokens: 500 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    expect(buildMatrix(input)).toHaveLength(0);
  });
});

describe('dominantMode: OPAQUE는 증거 부재이므로 다수결에서 제외', () => {
  it('OPAQUE 2 + UPFRONT 1 → UPFRONT (Gemini 실사례)', () => {
    const sessions = [
      { ...session('DEFERRED_OPAQUE'), sessionId: 'g1', client: 'gemini-cli' as const },
      { ...session('DEFERRED_OPAQUE'), sessionId: 'g2', client: 'gemini-cli' as const },
      { ...session('UPFRONT'), sessionId: 'g3', client: 'gemini-cli' as const },
    ];
    expect(dominantMode(sessions)).toBe('UPFRONT');
  });
  it('전부 OPAQUE면 OPAQUE', () => {
    expect(dominantMode([session('DEFERRED_OPAQUE')])).toBe('DEFERRED_OPAQUE');
  });
});

describe('visibleMatrixRows: 모드 인지 표시 필터', () => {
  const rows = (mode: any) => buildMatrix({
    definitions: [def('unused', 100), def('used', 100), def('loaded_only', 100)],
    calls: [call('used')],
    loads: [{ sessionId: 's1', serverName: 'github', toolName: 'loaded_only', loadedTokens: null }],
    sessions: [session(mode)],
  });

  it('지연 로딩: 호출 0 && 로드 0 행은 숨김 (실비용 0)', () => {
    const visible = visibleMatrixRows(rows('DEFERRED_MEASURABLE'),
      [session('DEFERRED_MEASURABLE')]);
    const names = visible.map((r) => r.toolName).sort();
    expect(names).toEqual(['loaded_only', 'used']); // unused만 숨겨짐
  });

  it('업프론트: 전부 표시 (미사용도 매 세션 실비용)', () => {
    const visible = visibleMatrixRows(rows('UPFRONT'), [session('UPFRONT')]);
    expect(visible).toHaveLength(3);
  });
});

describe('joinReason: reasonParts → reason 바이트 동일성 (Task 34 회귀)', () => {
  const RDAY = 86_400_000;
  const rat = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * RDAY).toISOString();

  // 12세션(day0~day11) — notion 계열 툴에겐 high 확신을 줄 만큼 충분한 관찰창
  const rsessions = Array.from({ length: 12 }, (_, i) => ({
    sessionId: `r${i}`, client: 'claude-code' as const, filePath: `/r/${i}`,
    startedAt: rat(i), mode: 'UPFRONT' as const }));

  // notion: 10툴 중 1개(t0)만 사용 → t1(오염 없음)·t2(오염 있음)는 filter-server, high 확신
  const notionDefs = Array.from({ length: 10 }, (_, i) => ({
    serverName: 'notion', toolName: `t${i}`, definitionTokens: 100,
    scannedAt: rat(0), firstScannedAt: rat(0) }));
  const notionCalls = [{
    sessionId: 'r0', serverName: 'notion', toolName: 't0',
    calledAt: rat(0), durationMs: 5, isError: false, responseTokens: 50, responseText: null }];
  const notionLoads = [{ sessionId: 'r0', serverName: 'notion', toolName: 't2', loadedTokens: null }];

  // small: 2툴 중 1개(friend) 사용, lonely는 미사용 & 늦게(day11) 스캔 → remove, low 확신
  const smallDefs = [
    { serverName: 'small', toolName: 'friend', definitionTokens: 80,
      scannedAt: rat(0), firstScannedAt: rat(0) },
    { serverName: 'small', toolName: 'lonely', definitionTokens: 80,
      scannedAt: rat(11), firstScannedAt: rat(11) },
  ];
  const smallCalls = [{
    sessionId: 'r11', serverName: 'small', toolName: 'friend',
    calledAt: rat(11), durationMs: 5, isError: false, responseTokens: 50, responseText: null }];

  // medserver: 2툴 중 1개(used) 사용, unused는 day5 스캔 → remove, medium 확신
  const medDefs = [
    { serverName: 'medserver', toolName: 'used', definitionTokens: 90,
      scannedAt: rat(0), firstScannedAt: rat(0) },
    { serverName: 'medserver', toolName: 'unused', definitionTokens: 90,
      scannedAt: rat(5), firstScannedAt: rat(5) },
  ];
  const medCalls = [{
    sessionId: 'r0', serverName: 'medserver', toolName: 'used',
    calledAt: rat(0), durationMs: 5, isError: false, responseTokens: 50, responseText: null }];

  // apis: flaky 3회 호출, 2회 실패 → inspect
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

  it('4종 action이 모두 등장한다', () => {
    const actions = new Set(rows.map((r) => r.recommendation.action));
    expect(actions).toEqual(new Set(['filter-server', 'remove', 'inspect', 'keep']));
  });

  it('모든 행에서 joinReason(reasonParts) === reason (바이트 동일)', () => {
    for (const r of rows) {
      expect(joinReason(r.recommendation.reasonParts)).toBe(r.recommendation.reason);
    }
  });

  it('filter-server: serverBasis가 서버 공통 근거를 담고, basis엔 새지 않는다', () => {
    const t1 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't1')!;
    expect(t1.recommendation.action).toBe('filter-server');
    expect(t1.recommendation.reasonParts.serverBasis).toContain('10툴 중 1개만 사용');
    expect(t1.recommendation.reasonParts.basis).not.toContain('10툴 중');
  });

  it('filter-server + 오염: pollutionSuffix가 effect에 접혀 들어간다', () => {
    const t2 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't2')!;
    expect(t2.recommendation.action).toBe('filter-server');
    expect(t2.recommendation.reasonParts.effect).toContain('검색 공간 오염');
  });

  it('remove: serverBasis는 null', () => {
    const lonely = rows.find((r) => r.serverName === 'small' && r.toolName === 'lonely')!;
    expect(lonely.recommendation.action).toBe('remove');
    expect(lonely.recommendation.reasonParts.serverBasis).toBeNull();
    const unused = rows.find((r) => r.serverName === 'medserver' && r.toolName === 'unused')!;
    expect(unused.recommendation.action).toBe('remove');
    expect(unused.recommendation.reasonParts.serverBasis).toBeNull();
  });

  it('remove 행끼리 확신 등급이 갈린다 (low vs medium)', () => {
    const lonely = rows.find((r) => r.serverName === 'small' && r.toolName === 'lonely')!;
    const unused = rows.find((r) => r.serverName === 'medserver' && r.toolName === 'unused')!;
    expect(lonely.recommendation.confidence).toBe('low');
    expect(unused.recommendation.confidence).toBe('medium');
  });

  it('inspect: caveat는 null, basis에 실패 정보가 담긴다', () => {
    const flaky = rows.find((r) => r.serverName === 'apis' && r.toolName === 'flaky')!;
    expect(flaky.recommendation.action).toBe('inspect');
    expect(flaky.recommendation.reasonParts.caveat).toBeNull();
    expect(flaky.recommendation.reasonParts.basis).toContain('실패');
  });

  it('keep: caveat는 null', () => {
    const t0 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't0')!;
    expect(t0.recommendation.action).toBe('keep');
    expect(t0.recommendation.reasonParts.caveat).toBeNull();
  });

  it('어떤 조각에도 대시(—)를 쓰지 않는다 (전역 산문 규칙)', () => {
    for (const r of rows) {
      const p = r.recommendation.reasonParts;
      for (const part of [p.basis, p.serverBasis, p.effect, p.caveat, r.recommendation.reason]) {
        expect(part ?? '').not.toContain('—');
      }
    }
  });

  it('조각은 마침표로 이어지고 마침표가 겹치지 않는다', () => {
    const t1 = rows.find((r) => r.serverName === 'notion' && r.toolName === 't1')!;
    // serverBasis가 이미 마침표로 끝나도 ".." 가 생기지 않는다.
    expect(t1.recommendation.reason).not.toContain('..');
    expect(t1.recommendation.reason).toContain('툴 필터링 권장. ');
  });
});

describe('권고 문구의 숫자 표기', () => {
  const bigDef = (tool: string, tokens: number) => ({
    serverName: 'notion', toolName: tool, definitionTokens: tokens,
    scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });

  it('정의 토큰과 절약 토큰에 천 단위 구분자가 들어간다', () => {
    const input: EngineInput = {
      definitions: [bigDef('huge', 12345)], calls: [], loads: [],
      sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.reasonParts.basis).toContain('정의 12,345토큰');
    expect(row.recommendation.reasonParts.effect).toContain('약 12,345토큰 절약');
    expect(row.recommendation.reason).not.toMatch(/\d{5}/);
  });

  it('실패 응답 낭비 토큰에도 구분자가 들어간다', () => {
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
    expect(row.recommendation.reasonParts.basis).toContain('16,000토큰 낭비');
    expect(row.recommendation.reason).toContain('낭비. 점검·대체 권장');
  });
});

describe('확신 등급 (evidence 축)', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const sess = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const scanned = (first: string) => ({
    serverName: 'github', toolName: 'unused', definitionTokens: 800,
    scannedAt: at(0), firstScannedAt: first });

  it('충분히 관찰한 미사용 툴 → remove high + 누적 부담 표기', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(12),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');
    expect(row.recommendation.confidence).toBe('high');
    expect(row.recommendation.evidence.observedSessions).toBe(12);
    expect(row.recommendation.evidence.totalObservedCost).toBe(9600);
    expect(row.recommendation.reason).toContain('복구');
  });

  it('관찰 2세션뿐이면 → remove low + 확정 아님 문구', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(2),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('remove');   // 판정은 강등되지 않는다
    expect(row.recommendation.confidence).toBe('low');  // 표시만 강등
    expect(row.recommendation.reason).toContain('확정 권고 아님');
  });

  it('창 밖 과거 호출 이력이 있으면 → remove medium + 마지막 호출일', () => {
    const input: EngineInput = {
      definitions: [scanned(at(0))], calls: [], loads: [], sessions: sess(12),
      lastCallByTool: new Map([['github unused', '2026-03-14T09:00:00Z']]),
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.confidence).toBe('medium');
    expect(row.recommendation.evidence.lastCalledAt).toBe('2026-03-14T09:00:00Z');
    expect(row.recommendation.reason).toContain('2026-03-14');
  });

  it('startedAt 미상 세션이 다수여도 high가 되지 않는다 (창 안 확인 세션 2개)', () => {
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
    expect(row.recommendation.evidence.observedSessions).toBe(17); // 계상은 그대로
    expect(row.recommendation.evidence.datedObservedSessions).toBe(2);
    expect(row.recommendation.evidence.observedDays).toBe(8);
    expect(row.recommendation.confidence).toBe('medium'); // high 아님
  });

  it('keep은 high 고정, evidence도 채워진다', () => {
    const input: EngineInput = {
      definitions: [def('used', 300)], calls: [call('used')],
      loads: [], sessions: [session('UPFRONT')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('keep');
    expect(row.recommendation.confidence).toBe('high');
    expect(row.recommendation.evidence.lastCalledAt).toBe('2026-07-10T00:00:00Z');
  });

  it('unknown은 low 고정', () => {
    const input: EngineInput = {
      definitions: [], calls: [],
      loads: [{ sessionId: 's1', serverName: 'unscanned', toolName: 'ghost', loadedTokens: 10 }],
      sessions: [session('DEFERRED_MEASURABLE')],
    };
    const [row] = buildMatrix(input);
    expect(row.recommendation.action).toBe('unknown');
    expect(row.recommendation.confidence).toBe('low');
  });

  it('inspect는 표본 크기로 등급이 갈린다', () => {
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

describe('splitByClient 정의 필터링', () => {
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

  it('serversByClient가 없으면 필터링하지 않는다 (기존 동작 보존)', () => {
    const parts = splitByClient(base);
    for (const p of parts) expect(p.input.definitions).toHaveLength(2);
  });

  it('serversByClient가 빈 맵(size 0)이어도 필터링하지 않는다 (C1 회귀 방지)', () => {
    const parts = splitByClient({ ...base, serversByClient: new Map() });
    for (const p of parts) expect(p.input.definitions).toHaveLength(2);
  });

  it('매핑된 서버의 정의만 그 클라이언트에 통과한다', () => {
    const parts = splitByClient({ ...base, serversByClient: new Map([
      ['claude-code', new Set(['notion'])],
      ['codex', new Set(['node_repl'])],
    ]) });
    const claude = parts.find((p) => p.client === 'claude-code')!;
    const codex = parts.find((p) => p.client === 'codex')!;
    expect(claude.input.definitions.map((x) => x.serverName)).toEqual(['notion']);
    expect(codex.input.definitions.map((x) => x.serverName)).toEqual(['node_repl']);
  });

  it('매핑에 없는 클라이언트는 정의가 0개다', () => {
    const parts = splitByClient({ ...base, serversByClient: new Map([
      ['claude-code', new Set(['notion'])],
    ]) });
    const codex = parts.find((p) => p.client === 'codex')!;
    expect(codex.input.definitions).toHaveLength(0);
  });

  it('매핑에 없어도 호출 이력이 있는 행은 매트릭스에 남는다', () => {
    const input = { ...base, calls: [c('x1', 'notion', 'search')],
      serversByClient: new Map([['codex', new Set(['node_repl'])]]) };
    const codex = splitByClient(input).find((p) => p.client === 'codex')!;
    const rows = buildMatrix(codex.input);
    expect(rows.some((r) => r.serverName === 'notion' && r.callCount === 1)).toBe(true);
  });

  it('매핑에 없어도 로드 이력이 있는 행은 매트릭스에 남는다', () => {
    const input = { ...base,
      loads: [{ sessionId: 'x1', serverName: 'notion', toolName: 'search', loadedTokens: null }],
      serversByClient: new Map([['codex', new Set(['node_repl'])]]) };
    const codex = splitByClient(input).find((p) => p.client === 'codex')!;
    const rows = buildMatrix(codex.input);
    expect(rows.some((r) => r.serverName === 'notion' && r.loadedSessionCount === 1)).toBe(true);
  });
});
