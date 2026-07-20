// packages/core/test/report/markdown.test.ts
// renderReport(ReportModel → markdown) 회귀 테스트.
// ReportModel은 손으로 만든 픽스처다 — 집계(buildReport)는 별도 터미널이 만든다.
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

describe('renderReport — 헤드라인·요약표', () => {
  it('헤드라인에 act 합계와 candidate 합계가 모두 나온다', () => {
    const out = renderReport(
      model({ totals: totals({ actPerSessionTokens: 3500, candidatePerSessionTokens: 15867 }) }),
      OPTS,
    );
    expect(out).toContain('세션당 3,500tok');
    expect(out).toContain('15,867tok');
  });

  it('천단위 구분자를 넣는다 (1000 미만은 그대로)', () => {
    const out = renderReport(
      model({
        clients: [
          client({
            buckets: {
              ...emptyBuckets(),
              act: [
                group({
                  serverName: 'demo-bigsuite',
                  caveat: '누적 부담 286,200tok · 설정 한 줄로 복구 가능',
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

  it('요약표 4행이 구분·대상·세션당 열로 렌더된다', () => {
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
    expect(out).toContain('| ✅ 지금 조치 | 서버 2 · 툴 11 | **3,500tok** |');
    expect(out).toContain('| ⏳ 관찰 더 필요 | 서버 2 · 툴 11 | 15,867tok (미확정) |');
    expect(out).toContain('| 🔧 점검 필요 | 툴 3 | 실패 응답 1,020tok 낭비 |');
    expect(out).toContain('| 👍 정상 사용 중 | 툴 21 | — |');
  });

  it('날짜는 opts.now의 앞 10자리다', () => {
    const out = renderReport(model(), { ...OPTS, now: '2026-07-20T12:34:56.000Z', days: 30 });
    expect(out).toContain('# MCP Lens — 최근 30일 (2026-07-20 기준)');
  });

  it('조치할 것이 전혀 없으면 그렇게 말한다', () => {
    const out = renderReport(model(), OPTS);
    expect(out).toContain('조치가 필요한 항목이 없습니다');
  });
});

describe('renderReport — 클라이언트 섹션', () => {
  it('클라이언트 헤더는 "## {client} · 세션 {n}개" 형식이다', () => {
    const out = renderReport(model({ clients: [client({ client: 'codex', sessionCount: 94 })] }), OPTS);
    expect(out).toContain('## codex · 세션 94개');
  });

  it('빈 버킷의 제목은 출력하지 않는다', () => {
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), healthy: [group()] } })] }),
      OPTS,
    );
    expect(out).not.toContain('### ✅ 지금 조치');
    expect(out).not.toContain('### ⏳ 관찰 더 필요');
    expect(out).not.toContain('### 🔧 점검 필요');
    expect(out).toContain('정상 사용 중');
  });

  it('클라이언트 사이 구분선 --- 을 넣는다', () => {
    const out = renderReport(
      model({ clients: [client({ client: 'claude-code' }), client({ client: 'codex' })] }),
      OPTS,
    );
    expect(out).toContain('---');
  });
});

describe('renderReport — act 버킷', () => {
  it('서버 공통 근거는 그룹 헤드라인에 한 번만 나온다 (균질 다수 툴 → blockquote)', () => {
    const manyTools = Array.from({ length: 9 }, (_, i) => tool({ toolName: `tool_${i + 1}`, perSessionTokens: 200 }));
    const g = group({
      serverName: 'demo-bigsuite',
      action: 'filter-server',
      headline: '10툴 중 `ping` 1개만 사용',
      caveat: '159세션/29일 관찰 · 누적 부담 286,200tok · 설정 한 줄로 복구 가능',
      perSessionTokens: 1800,
      tools: manyTools,
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      OPTS,
    );
    expect(out.match(/10툴 중 `ping` 1개만 사용/g)).toHaveLength(1);
    expect(out).toContain('세션당 1,800tok');
    expect(out).toContain('tool_1');
    expect(out).toContain('tool_9');
  });

  it('act 버킷 제목은 그룹 perSessionTokens 합이다', () => {
    const g1 = group({ serverName: 's1', perSessionTokens: 1800, tools: [tool({ perSessionTokens: 1800 })] });
    const g2 = group({ serverName: 's2', perSessionTokens: 1700, tools: [tool({ perSessionTokens: 1700 })] });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g1, g2] } })] }),
      OPTS,
    );
    expect(out).toContain('### ✅ 지금 조치 — 세션당 3,500tok');
  });

  it('summary 모드여도 act 그룹은 절단하지 않는다', () => {
    const manyTools = Array.from({ length: 9 }, (_, i) => tool({ toolName: `tool_${i + 1}`, perSessionTokens: 200 }));
    const g = group({ serverName: 'demo-bigsuite', headline: '9개 미사용', tools: manyTools });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      { ...OPTS, detail: 'summary' },
    );
    expect(out).not.toContain('그 외');
    expect(out).toContain('tool_1');
    expect(out).toContain('tool_9');
  });

  it('헤드라인 없는 act 그룹은 툴별 표로 렌더된다', () => {
    const g = group({
      serverName: 'demo-github',
      headline: null,
      perSessionTokens: 1700,
      tools: [
        tool({ toolName: 'list_issues', perSessionTokens: 800, lastCalledAt: null }),
        tool({ toolName: 'search_code', perSessionTokens: 900, lastCalledAt: '2026-05-21', note: '저빈도 툴일 수 있음 — 지연 로딩 유지 검토' }),
      ],
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('| 툴 | 세션당 | 마지막 호출 | 관찰 |');
    expect(out).toContain('list_issues');
    expect(out).toContain('800tok');
    expect(out).toContain('search_code');
    expect(out).toContain('저빈도 툴일 수 있음 — 지연 로딩 유지 검토');
  });
});

describe('renderReport — candidate 버킷', () => {
  it('summary 모드는 candidate 그룹 툴을 5개로 절단한다', () => {
    const manyTools = Array.from({ length: 14 }, (_, i) => tool({ toolName: `t${i}`, perSessionTokens: 100 }));
    const g = group({ serverName: 'notion', headline: '20툴 중 2개만 사용', tools: manyTools, perSessionTokens: 1400 });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      { ...OPTS, detail: 'summary' },
    );
    expect(out).toContain('그 외 9개');
  });

  it('full 모드는 절단하지 않는다', () => {
    const manyTools = Array.from({ length: 14 }, (_, i) => tool({ toolName: `t${i}`, perSessionTokens: 100 }));
    const g = group({ serverName: 'notion', headline: '20툴 중 2개만 사용', tools: manyTools, perSessionTokens: 1400 });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [g] } })] }),
      { ...OPTS, detail: 'full' },
    );
    expect(out).not.toContain('그 외');
    expect(out).toContain('t13');
  });

  it('단일 툴 candidate 그룹은 한 줄로 렌더된다', () => {
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

  it('candidate 버킷 제목에 관찰 필요 문구가 들어간다', () => {
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), candidate: [group()] } })] }),
      OPTS,
    );
    expect(out).toContain('### ⏳ 관찰 더 필요 — 10세션 누적 시 확정 (지금은 조치 권고 아님)');
  });
});

describe('renderReport — inspect / healthy 버킷', () => {
  it('inspect 버킷은 실패율·낭비 표를 렌더한다', () => {
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
    expect(out).toContain('### 🔧 점검 필요 — 실패가 잦은 툴');
    expect(out).toContain('| 툴 | 실패 | 낭비 |');
    expect(out).toContain('demo-github/flaky_search');
    expect(out).toContain('15회 중 9회 (60%)');
  });

  it('healthy 버킷은 "툴 N · 응답 Ntok" 제목과 한 줄 요약을 낸다', () => {
    const g = group({
      serverName: 'demo-github',
      action: 'keep',
      tools: [tool({ toolName: 'get_file', callCount: 30, responseTokens: 500 })],
    });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), healthy: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('### 👍 정상 사용 중 — 1툴 · 응답 500tok');
    expect(out).toContain('demo-github/get_file 30회');
  });
});

describe('renderReport — 접힌 클라이언트', () => {
  it('접힌 클라이언트는 3줄 이내다', () => {
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
      OPTS,
    );
    const section = out.split('## gemini-cli')[1];
    expect(section.trim().split('\n').filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(section).toContain('관찰 부족');
    expect(section).toContain('10세션 이상');
  });
});

describe('renderReport — 각주', () => {
  it('hiddenToolCount>0이면 지연 로딩 각주를 낸다', () => {
    const out = renderReport(
      model({ clients: [client({ hiddenToolCount: 78, buckets: { ...emptyBuckets(), healthy: [group()] } })] }),
      OPTS,
    );
    expect(out).toContain('지연 로딩');
    expect(out).toContain('78개');
  });

  it('hiddenToolCount=0이면 각주를 내지 않는다', () => {
    const out = renderReport(
      model({ clients: [client({ hiddenToolCount: 0, buckets: { ...emptyBuckets(), healthy: [group()] } })] }),
      OPTS,
    );
    expect(out).not.toContain('지연 로딩');
  });
});

describe('renderReport — 표시 정책', () => {
  it('HTML 태그를 쓰지 않는다', () => {
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

  it('정의 토큰은 항상 "세션당"으로 표기된다 (누적과 구분)', () => {
    const g = group({ serverName: 'demo-bigsuite', headline: 'h', perSessionTokens: 1800, totalObservedCost: 286200, tools: [tool()] });
    const out = renderReport(
      model({ clients: [client({ buckets: { ...emptyBuckets(), act: [g] } })] }),
      OPTS,
    );
    expect(out).toContain('세션당 1,800tok');
  });
});
