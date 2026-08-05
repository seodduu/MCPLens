import { describe, it, expect } from 'vitest';
import { buildSetupRows } from '../src/setupTree.js';

const base = {
  serverNames: ['notion', 'linear'],
  scanStatuses: new Map(),
  authIgnore: [] as string[],
  unsupported: [] as string[],
  analyzedServers: new Set<string>(),
  definitionServers: new Set<string>(),
  consent: undefined as { provider: string; model: string } | undefined,
  rollout: 'off',
};
const auth = (rows: ReturnType<typeof buildSetupRows>) =>
  rows.filter((r) => r.group === 'MCP authentication');

describe('buildSetupRows', () => {
  it('스캔 기록이 없는 서버는 never scanned 행이 된다', () => {
    const row = auth(buildSetupRows(base)).find((r) => r.label === 'notion');
    expect(row?.description).toBe('run a scan');
    expect(row?.command).toBe('mcp-lens.scanNow');
  });

  it('ok로 기록된 서버는 authenticated 행이 되고 클릭 커맨드가 없다', () => {
    const scanStatuses = new Map([['notion',
      { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses })).find((r) => r.label === 'notion');
    expect(row?.description).toBe('authenticated');
    expect(row?.command).toBeUndefined();
  });

  it('auth-required 서버는 login required 행이 되고 로그인 커맨드가 붙는다', () => {
    const scanStatuses = new Map([['linear',
      { status: 'auth-required' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses })).find((r) => r.label === 'linear');
    expect(row?.description).toBe('sign in to scan');
    expect(row?.command).toBe('mcp-lens.authenticateServer');
  });

  it('authIgnore에 있는 서버는 ignored 행이 되고 클릭 커맨드가 없다', () => {
    const scanStatuses = new Map([['linear',
      { status: 'auth-required' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const rows = buildSetupRows({ ...base, scanStatuses, authIgnore: ['linear'] });
    const row = auth(rows).find((r) => r.label === 'linear');
    expect(row?.description).toBe('ignored');
    expect(row?.command).toBeUndefined();
  });

  it('unsupportedServers에 있는 서버는 unsupported 행이 된다', () => {
    const row = auth(buildSetupRows({ ...base, unsupported: ['notion'] }))
      .find((r) => r.label === 'notion');
    expect(row?.description).toBe('not supported by Lens');
    expect(row?.command).toBeUndefined();
  });

  it('unsupported는 ok로 기록된 스캔 상태보다 우선한다', () => {
    const scanStatuses = new Map([['notion',
      { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses, unsupported: ['notion'] }))
      .find((r) => r.label === 'notion');
    expect(row?.description).toBe('not supported by Lens');
    expect(row?.command).toBeUndefined();
  });

  it('같은 서버가 unsupported이자 authIgnore여도 unsupported가 이긴다', () => {
    const row = auth(buildSetupRows({ ...base, unsupported: ['linear'], authIgnore: ['linear'] }))
      .find((r) => r.label === 'linear');
    expect(row?.description).toBe('not supported by Lens');
    expect(row?.command).toBeUndefined();
  });

  it('authIgnore는 ok로 기록된 스캔 상태보다 우선한다', () => {
    const scanStatuses = new Map([['notion',
      { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses, authIgnore: ['notion'] }))
      .find((r) => r.label === 'notion');
    expect(row?.description).toBe('ignored');
    expect(row?.command).toBeUndefined();
  });

  it('failed 서버는 errorCode를 description으로 쓴다', () => {
    const scanStatuses = new Map([['notion',
      { status: 'failed' as const, scannedAt: '2026-08-05T00:00:00.000Z', errorCode: 'ETIMEDOUT' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses })).find((r) => r.label === 'notion');
    expect(row?.description).toBe('ETIMEDOUT');
    expect(row?.command).toBe('mcp-lens.scanNow');
  });

  it('동의가 없으면 Provider 행 description이 consent required', () => {
    const row = buildSetupRows(base).find((r) => r.label === 'Provider');
    expect(row?.description).toBe('consent required');
  });

  it('동의가 있으면 Provider 행에 제공자와 consented가 표시된다', () => {
    const rows = buildSetupRows({ ...base, consent: { provider: 'claude', model: 'sonnet' } });
    expect(rows.find((r) => r.label === 'Provider')?.description).toBe('claude · consented');
  });

  it('Provider 행은 동의 여부와 무관하게 항상 analyzeDependencies 커맨드를 붙인다', () => {
    const withoutConsent = buildSetupRows(base).find((r) => r.label === 'Provider');
    expect(withoutConsent?.command).toBe('mcplens.analyzeDependencies');
    const withConsent = buildSetupRows({ ...base, consent: { provider: 'claude', model: 'sonnet' } })
      .find((r) => r.label === 'Provider');
    expect(withConsent?.command).toBe('mcplens.analyzeDependencies');
  });

  it('정의가 있는 서버만 분석 행이 된다', () => {
    const rows = buildSetupRows({
      ...base, definitionServers: new Set(['notion']), analyzedServers: new Set(['notion']) });
    const analysis = rows.filter((r) => r.group === 'Dependency analysis');
    expect(analysis.map((r) => r.label)).toEqual(['Provider', 'notion']);
    expect(analysis[1].description).toBe('analyzed');
  });

  it('정의는 있고 분석은 없는 서버는 not analyzed 행이 된다', () => {
    const rows = buildSetupRows({ ...base, definitionServers: new Set(['linear']) });
    const row = rows.find((r) => r.group === 'Dependency analysis' && r.label === 'linear');
    expect(row?.description).toBe('not analyzed');
    expect(row?.command).toBe('mcplens.reanalyzeServer');
  });

  it('rollout이 off면 Global actions 행 description이 locked', () => {
    const row = buildSetupRows(base).find((r) => r.group === 'Global actions');
    expect(row?.description).toBe('locked');
    expect(row?.icon).toBe('lock');
  });

  it('rollout이 claude면 enabled (claude)', () => {
    const row = buildSetupRows({ ...base, rollout: 'claude' })
      .find((r) => r.group === 'Global actions');
    expect(row?.description).toBe('enabled (claude)');
    expect(row?.icon).toBe('unlock');
  });
});

// 회색 아이콘만 늘어놓으면 어느 줄이 내 일인지 훑어서 알 수 없다.
describe('상태 색', () => {
  const ok = new Map([['notion', { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
  const failed = new Map([['notion',
    { status: 'failed' as const, scannedAt: '2026-08-05T00:00:00.000Z', errorCode: 'ENOENT' }]]);
  const rowFor = (input: Partial<typeof base>, label: string, group: string) =>
    buildSetupRows({ ...base, ...input }).find((r) => r.group === group && r.label === label);

  it('끝난 일은 파랑 — 수집 그룹의 Healthy와 같은 색', () => {
    expect(rowFor({ scanStatuses: ok }, 'notion', 'MCP authentication')?.colorId).toBe('charts.blue');
    expect(rowFor({ definitionServers: new Set(['notion']), analyzedServers: new Set(['notion']) },
      'notion', 'Dependency analysis')?.colorId).toBe('charts.blue');
    expect(rowFor({ rollout: 'all' }, 'Global actions', 'Global actions')?.colorId).toBe('charts.blue');
    expect(rowFor({ consent: { provider: 'codex', model: 'm' } }, 'Provider', 'Dependency analysis')
      ?.colorId).toBe('charts.blue');
  });

  it('아직 안 한 일은 노랑 — 잠긴 전역 조치도 고장이 아니라 남은 일이다', () => {
    expect(rowFor({}, 'notion', 'MCP authentication')?.colorId).toBe('charts.yellow');
    expect(rowFor({ definitionServers: new Set(['notion']) }, 'notion', 'Dependency analysis')
      ?.colorId).toBe('charts.yellow');
    expect(rowFor({ rollout: 'off' }, 'Global actions', 'Global actions')?.colorId).toBe('charts.yellow');
    expect(rowFor({}, 'Provider', 'Dependency analysis')?.colorId).toBe('charts.yellow');
  });

  it('실패한 스캔은 빨강', () => {
    expect(rowFor({ scanStatuses: failed }, 'notion', 'MCP authentication')?.colorId).toBe('charts.red');
  });

  // 무시는 되돌릴 수 있는 사용자 선택이다. 회색으로 묻으면 그 서버 비용이 계속 안 잡히는 걸 놓친다.
  it('무시한 서버는 빨강', () => {
    expect(rowFor({ authIgnore: ['notion'] }, 'notion', 'MCP authentication')?.colorId).toBe('charts.red');
  });

  it('Lens가 지원 못 하는 서버는 색이 없다 — 사용자가 할 수 있는 게 없다', () => {
    expect(rowFor({ unsupported: ['notion'] }, 'notion', 'MCP authentication')?.colorId).toBeUndefined();
  });
});
