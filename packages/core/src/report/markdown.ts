// packages/core/src/report/markdown.ts
// ReportModel -> markdown string: the rendering half of the action-first report.
// Design: docs/designs/2026-07-20-리포트-가독성-설계.md §3 (target output), §5 (display policy)
// Pure functions: no side effects, no file IO. core never imports vscode.
import type {
  ReportModel,
  ReportOptions,
  ReportGroup,
  ReportTool,
  ReportBucket,
  ClientReport,
} from './model.js';
import { SUMMARY_TOOL_LIMIT, NEVER_TRUNCATED } from './model.js';
import { incompleteScanLines } from './incompleteScans.js';

const BUCKET_ORDER: readonly ReportBucket[] = ['act', 'candidate', 'inspect', 'healthy'];

/** Thousands separators from 1000 up. Definition tokens always come back as "N tok"; the caller adds the "per session"/"accumulated" wording. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function tok(n: number): string {
  return `${fmt(n)}tok`;
}

/** Counts read as prose in this report, so singular forms must not say "1 tools". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Truncates candidate and healthy tool lists in summary mode. act and inspect are never truncated. */
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

/** Effect wording for an act group: describes the outcome per action type. */
function actEffect(g: ReportGroup): string {
  if (g.action === 'filter-server') return `filter ${plural(g.tools.length, 'tool')}, ${tok(g.perSessionTokens)}/session`;
  if (g.action === 'remove') return `remove, ${tok(g.perSessionTokens)}/session`;
  return `${tok(g.perSessionTokens)}/session`;
}

/** Folds many (4+) homogeneous tools (same per-session tokens, no call history) into one blockquote line. */
function isHomogeneous(tools: readonly ReportTool[]): boolean {
  if (tools.length < 4) return false;
  const first = tools[0].perSessionTokens;
  return tools.every((t) => t.callCount === 0 && t.perSessionTokens === first);
}

function homogeneousLine(tools: readonly ReportTool[]): string {
  const first = tools[0];
  const last = tools[tools.length - 1];
  return `> ${first.toolName} ~ ${last.toolName} · ${tok(first.perSessionTokens ?? 0)} each · never called`;
}

/** Detail table used for act groups without a headline (several non-homogeneous tools). */
function toolDetailTable(tools: readonly ReportTool[], c: ClientReport, opts: ReportOptions): string[] {
  const rows = ['| Tool | Per session | Last call | Observed |', '|---|---|---|---|'];
  for (const t of tools) {
    const perSession = t.perSessionTokens != null ? tok(t.perSessionTokens) : 'unmeasured';
    const lastCalled = t.lastCalledAt ? t.lastCalledAt.slice(0, 10) : 'never';
    const observed = t.note ?? `${plural(c.sessionCount, 'session')}/${opts.days}d`;
    rows.push(`| ${t.toolName} | ${perSession} | ${lastCalled} | ${observed} |`);
  }
  return rows;
}

function renderActGroup(g: ReportGroup, c: ClientReport, opts: ReportOptions): string[] {
  const lines: string[] = [];
  const unmeasuredNote = g.hasUnmeasured ? ' · partly unmeasured' : '';
  if (g.headline) {
    lines.push(`**${g.serverName} · ${g.headline}** → ${actEffect(g)}${unmeasuredNote}`);
    if (g.caveat) lines.push(g.caveat);
    if (isHomogeneous(g.tools)) {
      lines.push(homogeneousLine(g.tools));
    } else {
      lines.push(...toolDetailTable(g.tools, c, opts));
    }
  } else {
    lines.push(`**${g.serverName} · ${plural(g.tools.length, 'unused tool')}** → ${tok(g.perSessionTokens)}/session${unmeasuredNote}`);
    if (g.caveat) lines.push(g.caveat);
    lines.push(...toolDetailTable(g.tools, c, opts));
  }
  lines.push('');
  return lines;
}

/** A null perSessionTokens shows as "unmeasured" instead of collapsing into 0tok. */
function perSessionLabel(n: number | null): string {
  return n != null ? tok(n) : 'unmeasured';
}

function renderCandidateGroup(g: ReportGroup, c: ClientReport, opts: ReportOptions): string[] {
  const lines: string[] = [];
  if (g.tools.length === 1 && !g.headline) {
    const t = g.tools[0];
    const observed = t.note ?? `${plural(c.sessionCount, 'session')} observed`;
    lines.push(`**${g.serverName}/${t.toolName}** · ${perSessionLabel(t.perSessionTokens)} · ${observed}`);
  } else {
    const headline = g.headline ?? `${plural(g.tools.length, 'tool')} unused`;
    const unmeasuredNote = g.hasUnmeasured ? ' · partly unmeasured' : '';
    lines.push(
      `**${g.serverName} · ${headline}**${unmeasuredNote} · ${plural(c.sessionCount, 'session')} observed · ${tok(g.perSessionTokens)}/session once confirmed`,
    );
    const { shown, restCount, restTokens } = truncateTools(g.tools, 'candidate', opts);
    const parts = shown.map((t) => `${t.toolName} ${perSessionLabel(t.perSessionTokens)}`);
    if (restCount > 0) parts.push(`+${restCount} more ${tok(restTokens)}`);
    lines.push(`> ${parts.join(' · ')}`);
  }
  lines.push('');
  return lines;
}

function renderInspectBucket(groups: readonly ReportGroup[]): string[] {
  const rows = ['| Tool | Failures | Wasted |', '|---|---|---|'];
  for (const g of groups) {
    for (const t of g.tools) {
      const rate = t.errorRate != null ? `${Math.round(t.errorRate * 100)}%` : '—';
      const wasted = t.responseTokens * t.errorCount;
      rows.push(`| ${g.serverName}/${t.toolName} | ${t.errorCount} of ${t.callCount} (${rate}) | ${tok(wasted)} |`);
    }
  }
  rows.push('');
  return rows;
}

function renderHealthyBucket(groups: readonly ReportGroup[], opts: ReportOptions): string[] {
  const flat = groups.flatMap((g) => g.tools.map((t) => ({ tool: t, serverName: g.serverName })));
  const truncatable = opts.detail === 'summary' && !NEVER_TRUNCATED.includes('healthy') && flat.length > 6;
  const shown = truncatable ? flat.slice(0, SUMMARY_TOOL_LIMIT) : flat;
  const parts = shown.map((e) => `${e.serverName}/${e.tool.toolName} ${plural(e.tool.callCount, 'call')}`);
  let line = parts.join(' · ');
  if (truncatable) line += ' · …';
  return [line, ''];
}

function bucketTitle(bucket: ReportBucket, groups: readonly ReportGroup[]): string {
  switch (bucket) {
    case 'act':
      return `### ✅ Act now: ${tok(sumPerSessionTokens(groups))}/session`;
    case 'candidate':
      return '### ⏳ Needs more observation: not a recommendation yet';
    case 'inspect':
      return '### 🔧 Needs inspection: frequently failing tools';
    case 'healthy': {
      const toolCount = groups.reduce((s, g) => s + g.tools.length, 0);
      const respTokens = groups.reduce(
        (s, g) => s + g.tools.reduce((s2, t) => s2 + t.responseTokens, 0),
        0,
      );
      return `### 👍 In healthy use: ${plural(toolCount, 'tool')} · ${tok(respTokens)} responses`;
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
  // What blocks confidence may be session count, observed days or past call history, and
  // ReportModel does not carry that axis. Claiming a specific threshold would tell a
  // 148-session client to "use it for 10+ sessions", so no condition is named.
  return [
    '**No confirmed recommendations. Not enough observation yet.** Keep using it and candidates get confirmed.',
    `${plural(toolCount, 'unused definition')} · ${tok(tokens)}/session (${plural(c.sessionCount, 'session')} observed, confirmation threshold not met). Full list: \`--full\``,
  ];
}

function renderClient(c: ClientReport, opts: ReportOptions): string[] {
  const lines: string[] = ['', '---', '', `## ${c.client} · ${plural(c.sessionCount, 'session')}`];

  // full is the escape hatch for "show everything", so it must undo folding as well as truncation.
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
      `_Deferred loading: ${plural(c.hiddenToolCount, 'tool')} with 0 loads and 0 calls have no real cost and are excluded from totals and display_`,
    );
  }

  if (c.unmeasuredToolCount > 0) {
    lines.push(
      `_${plural(c.unmeasuredToolCount, 'tool')} with no definition tokens (not covered by the scanner) are undecided and excluded from the totals above_`,
    );
  }

  // Under deferred loading a definition that never loaded never reached the model, so there is no
  // evidence to act on. Saying nothing would let these tools read as "healthy".
  if (c.unobservedToolCount > 0) {
    lines.push(
      `_${plural(c.unobservedToolCount, 'tool')} never loaded under deferred loading are not yet judged_`,
    );
  }

  return lines;
}

/** ReportModel -> markdown string. Raw markdown only, no HTML tags (§5). */
export function renderReport(model: ReportModel, opts: ReportOptions): string {
  const now = opts.now ?? new Date().toISOString();
  const date = now.slice(0, 10);
  const t = model.totals;

  const lines: string[] = [];
  lines.push(`# MCP Lens · last ${opts.days} days (as of ${date})`, '');
  // The lead sentence reflects the real state: opening with "you can save 0tok" when there is
  // nothing to act on makes the first line of the report carry no information.
  if (t.actPerSessionTokens > 0) {
    lines.push(`Acting now saves **${tok(t.actPerSessionTokens)} per session**.`);
    lines.push(`With more observation, another ${tok(t.candidatePerSessionTokens)} of candidates gets confirmed.`, '');
  } else {
    lines.push('**No confirmed actions right now.**');
    lines.push(`With more observation, ${tok(t.candidatePerSessionTokens)} of candidates becomes actionable.`, '');
  }
  lines.push('| Category | Scope | Per session |');
  lines.push('|---|---|---|');
  lines.push(`| ✅ Act now | ${plural(t.actServerCount, 'server')} · ${plural(t.actToolCount, 'tool')} | **${tok(t.actPerSessionTokens)}** |`);
  lines.push(
    `| ⏳ Needs more observation | ${plural(t.candidateServerCount, 'server')} · ${plural(t.candidateToolCount, 'tool')} | ${tok(t.candidatePerSessionTokens)} (unconfirmed) |`,
  );
  lines.push(`| 🔧 Needs inspection | ${plural(t.inspectToolCount, 'tool')} | ${tok(t.inspectWastedTokens)} wasted on failed responses |`);
  lines.push(`| 👍 In healthy use | ${plural(t.healthyToolCount, 'tool')} | — |`);

  // A server whose scan did not complete is listed before the conflict note: its rows below come
  // from call history alone, so its totals understate it. Saying nothing would let a two-row
  // server read as cheap when its 13 definitions were simply never measured.
  // Tolerates a model built before this field existed (hand-made fixtures, older callers): an
  // absent list means "nothing to say", never a crash in the renderer.
  const incomplete = model.incompleteServers ?? [];
  if (incomplete.length > 0) {
    lines.push('');
    for (const line of incompleteScanLines(incomplete)) lines.push(`> ${line}.`);
  }

  if (model.conflictedServers.length > 0) {
    lines.push(
      '',
      `> Excluded from the totals: ${plural(model.conflictedServers.length, 'server')} defined under the same name by more than one client (${model.conflictedServers.join(', ')}).`,
    );
  }

  // Server-level evidence stands on its own: under deferred loading none of these servers' tools
  // ever loaded, so no tool row can carry the finding. Placed above the client sections, after the
  // summary table, so the heading does not swallow the table.
  const serverVerdicts = model.serverVerdicts ?? [];
  if (serverVerdicts.length > 0) {
    lines.push('', '## Servers never used', '');
    for (const v of serverVerdicts) {
      lines.push(`- **${v.serverName}**: ${v.reason} (${v.confidence})`);
    }
  }

  if (t.actToolCount === 0 && t.inspectToolCount === 0) {
    lines.push('', 'Nothing needs action right now.');
  }

  for (const c of model.clients) {
    lines.push(...renderClient(c, opts));
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
