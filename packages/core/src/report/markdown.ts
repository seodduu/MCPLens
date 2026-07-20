// packages/core/src/report/markdown.ts
// ReportModel → 마크다운 문자열. 조치 중심 리포트의 렌더링 절반.
// 설계: docs/designs/2026-07-20-리포트-가독성-설계.md §3(목표 출력)·§5(표시 정책)
// 순수 함수 — 부수효과·파일 IO 없음. core는 vscode를 import하지 않는다.
import type {
  ReportModel,
  ReportOptions,
  ReportGroup,
  ReportTool,
  ReportBucket,
  ClientReport,
} from './model.js';
import { SUMMARY_TOOL_LIMIT, NEVER_TRUNCATED } from './model.js';

const BUCKET_ORDER: readonly ReportBucket[] = ['act', 'candidate', 'inspect', 'healthy'];

/** 1000 이상은 천단위 구분자. 정의 토큰은 항상 "N tok" 형태로 반환한다 (호출부에서 "세션당"/"누적" 문구를 붙인다). */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function tok(n: number): string {
  return `${fmt(n)}tok`;
}

/** summary 모드에서 candidate·healthy 그룹의 툴 목록을 절단한다. act·inspect는 절대 절단하지 않는다. */
function truncateTools(
  tools: readonly ReportTool[],
  bucket: ReportBucket,
  opts: ReportOptions,
): { shown: readonly ReportTool[]; restCount: number; restTokens: number } {
  const truncatable = opts.detail === 'summary' && !NEVER_TRUNCATED.includes(bucket);
  if (!truncatable || tools.length <= 6) {
    return { shown: tools, restCount: 0, restTokens: 0 };
  }
  const shown = tools.slice(0, SUMMARY_TOOL_LIMIT);
  const rest = tools.slice(SUMMARY_TOOL_LIMIT);
  const restTokens = rest.reduce((s, t) => s + (t.perSessionTokens ?? 0), 0);
  return { shown, restCount: rest.length, restTokens };
}

function sumPerSessionTokens(groups: readonly ReportGroup[]): number {
  return groups.reduce((s, g) => s + g.perSessionTokens, 0);
}

/** act 조치 효과 문구 — action 유형별로 조치 결과를 설명한다. */
function actEffect(g: ReportGroup): string {
  if (g.action === 'filter-server') return `${g.tools.length}툴 필터링, 세션당 ${tok(g.perSessionTokens)}`;
  if (g.action === 'remove') return `제거, 세션당 ${tok(g.perSessionTokens)}`;
  return `세션당 ${tok(g.perSessionTokens)}`;
}

/** 툴이 많고(4개+) 균질(동일 세션당 토큰·호출 이력 없음)하면 blockquote 한 줄로 접는다. */
function isHomogeneous(tools: readonly ReportTool[]): boolean {
  if (tools.length < 4) return false;
  const first = tools[0].perSessionTokens;
  return tools.every((t) => t.callCount === 0 && t.perSessionTokens === first);
}

function homogeneousLine(tools: readonly ReportTool[]): string {
  const first = tools[0];
  const last = tools[tools.length - 1];
  return `> ${first.toolName} ~ ${last.toolName} · 각 ${tok(first.perSessionTokens ?? 0)} · 호출 이력 없음`;
}

/** act 그룹의 헤드라인 없는 경우(균질하지 않은 다수 툴) 쓰는 상세 표. */
function toolDetailTable(tools: readonly ReportTool[], c: ClientReport, opts: ReportOptions): string[] {
  const rows = ['| 툴 | 세션당 | 마지막 호출 | 관찰 |', '|---|---|---|---|'];
  for (const t of tools) {
    const perSession = t.perSessionTokens != null ? tok(t.perSessionTokens) : '미측정';
    const lastCalled = t.lastCalledAt ? t.lastCalledAt.slice(0, 10) : '없음';
    const observed = t.note ?? `${c.sessionCount}세션/${opts.days}일`;
    rows.push(`| ${t.toolName} | ${perSession} | ${lastCalled} | ${observed} |`);
  }
  return rows;
}

function renderActGroup(g: ReportGroup, c: ClientReport, opts: ReportOptions): string[] {
  const lines: string[] = [];
  const unmeasuredNote = g.hasUnmeasured ? ' · 일부 미측정' : '';
  if (g.headline) {
    lines.push(`**${g.serverName} — ${g.headline}** → ${actEffect(g)}${unmeasuredNote}`);
    if (g.caveat) lines.push(g.caveat);
    if (isHomogeneous(g.tools)) {
      lines.push(homogeneousLine(g.tools));
    } else {
      lines.push(...toolDetailTable(g.tools, c, opts));
    }
  } else {
    lines.push(`**${g.serverName} — 미사용 툴 ${g.tools.length}개** → 세션당 ${tok(g.perSessionTokens)}${unmeasuredNote}`);
    if (g.caveat) lines.push(g.caveat);
    lines.push(...toolDetailTable(g.tools, c, opts));
  }
  lines.push('');
  return lines;
}

/** perSessionTokens가 null(미측정)이면 0tok으로 뭉개지 않고 "미측정"으로 표시한다. */
function perSessionLabel(n: number | null): string {
  return n != null ? tok(n) : '미측정';
}

function renderCandidateGroup(g: ReportGroup, c: ClientReport, opts: ReportOptions): string[] {
  const lines: string[] = [];
  if (g.tools.length === 1 && !g.headline) {
    const t = g.tools[0];
    const observed = t.note ?? `${c.sessionCount}세션 관찰`;
    lines.push(`**${g.serverName}/${t.toolName}** · ${perSessionLabel(t.perSessionTokens)} · ${observed}`);
  } else {
    const headline = g.headline ?? `${g.tools.length}툴 미사용`;
    const unmeasuredNote = g.hasUnmeasured ? ' · 일부 미측정' : '';
    lines.push(
      `**${g.serverName} — ${headline}**${unmeasuredNote} · ${c.sessionCount}세션 관찰 · 확정 시 세션당 ${tok(g.perSessionTokens)}`,
    );
    const { shown, restCount, restTokens } = truncateTools(g.tools, 'candidate', opts);
    const parts = shown.map((t) => `${t.toolName} ${perSessionLabel(t.perSessionTokens)}`);
    if (restCount > 0) parts.push(`그 외 ${restCount}개 ${tok(restTokens)}`);
    lines.push(`> ${parts.join(' · ')}`);
  }
  lines.push('');
  return lines;
}

function renderInspectBucket(groups: readonly ReportGroup[]): string[] {
  const rows = ['| 툴 | 실패 | 낭비 |', '|---|---|---|'];
  for (const g of groups) {
    for (const t of g.tools) {
      const rate = t.errorRate != null ? `${Math.round(t.errorRate * 100)}%` : '—';
      const wasted = t.responseTokens * t.errorCount;
      rows.push(`| ${g.serverName}/${t.toolName} | ${t.callCount}회 중 ${t.errorCount}회 (${rate}) | ${tok(wasted)} |`);
    }
  }
  rows.push('');
  return rows;
}

function renderHealthyBucket(groups: readonly ReportGroup[], opts: ReportOptions): string[] {
  const flat = groups.flatMap((g) => g.tools.map((t) => ({ tool: t, serverName: g.serverName })));
  const truncatable = opts.detail === 'summary' && !NEVER_TRUNCATED.includes('healthy') && flat.length > 6;
  const shown = truncatable ? flat.slice(0, SUMMARY_TOOL_LIMIT) : flat;
  const parts = shown.map((e) => `${e.serverName}/${e.tool.toolName} ${e.tool.callCount}회`);
  let line = parts.join(' · ');
  if (truncatable) line += ' · …';
  return [line, ''];
}

function bucketTitle(bucket: ReportBucket, groups: readonly ReportGroup[]): string {
  switch (bucket) {
    case 'act':
      return `### ✅ 지금 조치 — 세션당 ${tok(sumPerSessionTokens(groups))}`;
    case 'candidate':
      return '### ⏳ 관찰 더 필요 — 아직 조치 권고 아님';
    case 'inspect':
      return '### 🔧 점검 필요 — 실패가 잦은 툴';
    case 'healthy': {
      const toolCount = groups.reduce((s, g) => s + g.tools.length, 0);
      const respTokens = groups.reduce(
        (s, g) => s + g.tools.reduce((s2, t) => s2 + t.responseTokens, 0),
        0,
      );
      return `### 👍 정상 사용 중 — ${toolCount}툴 · 응답 ${tok(respTokens)}`;
    }
  }
}

function renderBucketBody(
  bucket: ReportBucket,
  groups: readonly ReportGroup[],
  c: ClientReport,
  opts: ReportOptions,
): string[] {
  switch (bucket) {
    case 'act':
      return groups.flatMap((g) => renderActGroup(g, c, opts));
    case 'candidate':
      return groups.flatMap((g) => renderCandidateGroup(g, c, opts));
    case 'inspect':
      return renderInspectBucket(groups);
    case 'healthy':
      return renderHealthyBucket(groups, opts);
  }
}

function renderCollapsedClient(c: ClientReport): string[] {
  const toolCount = c.collapsedSummary?.toolCount ?? 0;
  const tokens = c.collapsedSummary?.perSessionTokens ?? 0;
  // 확신을 막는 조건은 세션 수·관찰 일수·과거 호출 이력 중 무엇이든 될 수 있고,
  // ReportModel은 그 축을 담지 않는다. 특정 임계값을 주장하면 148세션에 대고
  // "10세션 이상 쓰면"이라 말하는 자기모순이 난다 — 조건을 특정하지 않는다.
  return [
    '**확정 권고 없음 — 관찰 근거 부족.** 계속 쓰면 후보가 확정됩니다.',
    `미사용 정의 ${toolCount}개 · 세션당 ${tok(tokens)} (${c.sessionCount}세션 관찰, 아직 확정 조건 미달) — 목록은 \`--full\``,
  ];
}

function renderClient(c: ClientReport, opts: ReportOptions): string[] {
  const lines: string[] = ['', '---', '', `## ${c.client} · 세션 ${c.sessionCount}개`];

  // full은 "전량 보기"의 탈출구다 — 절단뿐 아니라 접기도 풀어야 일관된다.
  if (c.collapsed && opts.detail === 'summary') {
    lines.push('');
    lines.push(...renderCollapsedClient(c));
    return lines;
  }

  for (const bucket of BUCKET_ORDER) {
    const groups = c.buckets[bucket];
    if (groups.length === 0) continue;
    lines.push('');
    lines.push(bucketTitle(bucket, groups));
    lines.push('');
    lines.push(...renderBucketBody(bucket, groups, c, opts));
  }

  if (c.hiddenToolCount > 0) {
    lines.push(
      `_지연 로딩 — 로드·호출 0회로 실비용이 없는 툴 ${c.hiddenToolCount}개는 계산·표시에서 제외_`,
    );
  }

  if (c.unmeasuredToolCount > 0) {
    lines.push(
      `_정의 토큰 미확보(스캐너 미커버) 툴 ${c.unmeasuredToolCount}개는 판정 보류 — 위 집계에서 제외_`,
    );
  }

  return lines;
}

/** ReportModel → 마크다운 문자열. HTML 태그 없이 raw 마크다운만 사용한다 (§5). */
export function renderReport(model: ReportModel, opts: ReportOptions): string {
  const now = opts.now ?? new Date().toISOString();
  const date = now.slice(0, 10);
  const t = model.totals;

  const lines: string[] = [];
  lines.push(`# MCP Lens — 최근 ${opts.days}일 (${date} 기준)`, '');
  // 리드 문장은 실제 상태를 반영한다 — 조치 대상이 없는데 "0tok 줄일 수 있습니다"로
  // 시작하면 리포트의 첫 줄이 아무 정보도 주지 못한다.
  if (t.actPerSessionTokens > 0) {
    lines.push(`지금 조치하면 **세션당 ${tok(t.actPerSessionTokens)}**을 줄일 수 있습니다.`);
    lines.push(`관찰이 더 쌓이면 후보 ${tok(t.candidatePerSessionTokens)}이 추가로 확정됩니다.`, '');
  } else {
    lines.push('**지금 확정된 조치는 없습니다.**');
    lines.push(`관찰이 더 쌓이면 후보 ${tok(t.candidatePerSessionTokens)}이 확정 대상이 됩니다.`, '');
  }
  lines.push('| 구분 | 대상 | 세션당 |');
  lines.push('|---|---|---|');
  lines.push(`| ✅ 지금 조치 | 서버 ${t.actServerCount} · 툴 ${t.actToolCount} | **${tok(t.actPerSessionTokens)}** |`);
  lines.push(
    `| ⏳ 관찰 더 필요 | 서버 ${t.candidateServerCount} · 툴 ${t.candidateToolCount} | ${tok(t.candidatePerSessionTokens)} (미확정) |`,
  );
  lines.push(`| 🔧 점검 필요 | 툴 ${t.inspectToolCount} | 실패 응답 ${tok(t.inspectWastedTokens)} 낭비 |`);
  lines.push(`| 👍 정상 사용 중 | 툴 ${t.healthyToolCount} | — |`);

  if (t.actToolCount === 0 && t.inspectToolCount === 0) {
    lines.push('', '지금 조치가 필요한 항목이 없습니다.');
  }

  for (const c of model.clients) {
    lines.push(...renderClient(c, opts));
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
