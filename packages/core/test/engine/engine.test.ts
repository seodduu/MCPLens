// packages/core/test/engine/engine.test.ts
import { describe, it, expect } from 'vitest';
import { buildMatrix, sessionSavings, splitByClient, dominantMode, visibleMatrixRows } from '../../src/engine/engine.js';
import type { EngineInput } from '../../src/engine/engine.js';

const def = (tool: string, tokens: number) => ({
  serverName: 'github', toolName: tool, definitionTokens: tokens,
  scannedAt: '2026-07-19T00:00:00Z' });
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
