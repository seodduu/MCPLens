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
  walkthroughOpened: true,
};
const auth = (rows: ReturnType<typeof buildSetupRows>) =>
  rows.filter((r) => r.group === 'MCP authentication');

describe('buildSetupRows', () => {
  it('turns a server with no scan record into a never scanned row', () => {
    const row = auth(buildSetupRows(base)).find((r) => r.label === 'notion');
    expect(row?.description).toBe('run a scan');
    expect(row?.command).toBe('mcp-lens.scanNow');
  });

  it('turns a server recorded ok into an authenticated row with no click command', () => {
    const scanStatuses = new Map([['notion',
      { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses })).find((r) => r.label === 'notion');
    expect(row?.description).toBe('authenticated');
    expect(row?.command).toBeUndefined();
  });

  it('turns an auth-required server into a login required row with a login command', () => {
    const scanStatuses = new Map([['linear',
      { status: 'auth-required' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses })).find((r) => r.label === 'linear');
    expect(row?.description).toBe('sign in to scan');
    expect(row?.command).toBe('mcp-lens.authenticateServer');
  });

  it('turns a server in authIgnore into an ignored row with no click command', () => {
    const scanStatuses = new Map([['linear',
      { status: 'auth-required' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const rows = buildSetupRows({ ...base, scanStatuses, authIgnore: ['linear'] });
    const row = auth(rows).find((r) => r.label === 'linear');
    expect(row?.description).toBe('ignored');
    expect(row?.command).toBeUndefined();
    // The hover sign-in button is routed by this contextValue, so an ignored server can be undone.
    expect(row?.contextValue).toBe('auth-ignored');
  });

  it('turns a server in unsupportedServers into an unsupported row', () => {
    const row = auth(buildSetupRows({ ...base, unsupported: ['notion'] }))
      .find((r) => r.label === 'notion');
    expect(row?.description).toBe('not supported by Lens');
    expect(row?.command).toBeUndefined();
  });

  it('lets unsupported outrank a scan state recorded ok', () => {
    const scanStatuses = new Map([['notion',
      { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses, unsupported: ['notion'] }))
      .find((r) => r.label === 'notion');
    expect(row?.description).toBe('not supported by Lens');
    expect(row?.command).toBeUndefined();
  });

  it('lets unsupported win when a server is both unsupported and in authIgnore', () => {
    const row = auth(buildSetupRows({ ...base, unsupported: ['linear'], authIgnore: ['linear'] }))
      .find((r) => r.label === 'linear');
    expect(row?.description).toBe('not supported by Lens');
    expect(row?.command).toBeUndefined();
  });

  it('lets authIgnore outrank a scan state recorded ok', () => {
    const scanStatuses = new Map([['notion',
      { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses, authIgnore: ['notion'] }))
      .find((r) => r.label === 'notion');
    expect(row?.description).toBe('ignored');
    expect(row?.command).toBeUndefined();
  });

  it('uses errorCode as the description of a failed server', () => {
    const scanStatuses = new Map([['notion',
      { status: 'failed' as const, scannedAt: '2026-08-05T00:00:00.000Z', errorCode: 'ETIMEDOUT' }]]);
    const row = auth(buildSetupRows({ ...base, scanStatuses })).find((r) => r.label === 'notion');
    expect(row?.description).toBe('ETIMEDOUT');
    expect(row?.command).toBe('mcp-lens.scanNow');
  });

  it('describes the Provider row as consent required without consent', () => {
    const row = buildSetupRows(base).find((r) => r.label === 'Provider');
    expect(row?.description).toBe('consent required');
  });

  it('shows the provider and consented on the Provider row with consent', () => {
    const rows = buildSetupRows({ ...base, consent: { provider: 'claude', model: 'sonnet' } });
    expect(rows.find((r) => r.label === 'Provider')?.description).toBe('claude · consented');
  });

  it('always attaches the analyzeDependencies command to the Provider row, with or without consent', () => {
    const withoutConsent = buildSetupRows(base).find((r) => r.label === 'Provider');
    expect(withoutConsent?.command).toBe('mcplens.analyzeDependencies');
    const withConsent = buildSetupRows({ ...base, consent: { provider: 'claude', model: 'sonnet' } })
      .find((r) => r.label === 'Provider');
    expect(withConsent?.command).toBe('mcplens.analyzeDependencies');
  });

  it('turns only servers with definitions into analysis rows', () => {
    const rows = buildSetupRows({
      ...base, definitionServers: new Set(['notion']), analyzedServers: new Set(['notion']) });
    const analysis = rows.filter((r) => r.group === 'Dependency analysis');
    expect(analysis.map((r) => r.label)).toEqual(['Provider', 'notion']);
    expect(analysis[1].description).toBe('analyzed');
  });

  it('turns a server with definitions but no analysis into a not analyzed row', () => {
    const rows = buildSetupRows({ ...base, definitionServers: new Set(['linear']) });
    const row = rows.find((r) => r.group === 'Dependency analysis' && r.label === 'linear');
    expect(row?.description).toBe('not analyzed');
    expect(row?.command).toBe('mcplens.reanalyzeServer');
  });

  it('describes the Global actions row as locked when rollout is off', () => {
    const row = buildSetupRows(base).find((r) => r.group === 'Global actions');
    expect(row?.description).toBe('locked');
    expect(row?.icon).toBe('lock');
  });

  it('describes it as enabled (claude) when rollout is claude', () => {
    const row = buildSetupRows({ ...base, rollout: 'claude' })
      .find((r) => r.group === 'Global actions');
    expect(row?.description).toBe('enabled (claude)');
    expect(row?.icon).toBe('unlock');
  });
});

// A wall of grey icons makes it impossible to scan for the row that needs you.
describe('status colour', () => {
  const ok = new Map([['notion', { status: 'ok' as const, scannedAt: '2026-08-05T00:00:00.000Z' }]]);
  const failed = new Map([['notion',
    { status: 'failed' as const, scannedAt: '2026-08-05T00:00:00.000Z', errorCode: 'ENOENT' }]]);
  const rowFor = (input: Partial<typeof base>, label: string, group: string) =>
    buildSetupRows({ ...base, ...input }).find((r) => r.group === group && r.label === label);

  it('colours finished work blue, the same as Healthy in the collection group', () => {
    expect(rowFor({ scanStatuses: ok }, 'notion', 'MCP authentication')?.colorId).toBe('charts.blue');
    expect(rowFor({ definitionServers: new Set(['notion']), analyzedServers: new Set(['notion']) },
      'notion', 'Dependency analysis')?.colorId).toBe('charts.blue');
    expect(rowFor({ rollout: 'all' }, 'Global actions', 'Global actions')?.colorId).toBe('charts.blue');
    expect(rowFor({ consent: { provider: 'codex', model: 'm' } }, 'Provider', 'Dependency analysis')
      ?.colorId).toBe('charts.blue');
  });

  it('colours unfinished work yellow: a locked global action is work left, not a fault', () => {
    expect(rowFor({}, 'notion', 'MCP authentication')?.colorId).toBe('charts.yellow');
    expect(rowFor({ definitionServers: new Set(['notion']) }, 'notion', 'Dependency analysis')
      ?.colorId).toBe('charts.yellow');
    expect(rowFor({ rollout: 'off' }, 'Global actions', 'Global actions')?.colorId).toBe('charts.yellow');
    expect(rowFor({}, 'Provider', 'Dependency analysis')?.colorId).toBe('charts.yellow');
  });

  it('colours a failed scan red', () => {
    expect(rowFor({ scanStatuses: failed }, 'notion', 'MCP authentication')?.colorId).toBe('charts.red');
  });

  // Ignoring is a reversible user choice. Buried in grey, the cost of that server keeps going unnoticed.
  it('colours an ignored server red', () => {
    expect(rowFor({ authIgnore: ['notion'] }, 'notion', 'MCP authentication')?.colorId).toBe('charts.red');
  });

  it('gives a server Lens cannot support no colour: there is nothing the user can do', () => {
    expect(rowFor({ unsupported: ['notion'] }, 'notion', 'MCP authentication')?.colorId).toBeUndefined();
  });
});

// The walkthrough is the only place that explains what a scan costs and what hooks collect. Reaching it
// through the command palette assumes the user already knows it exists, which a first-time user does not.
describe('buildSetupRows: the Get started row', () => {
  it('leads the view before the walkthrough has ever been opened', () => {
    const rows = buildSetupRows({ ...base, walkthroughOpened: false });
    expect(rows[0]?.label).toBe('Get started');
    expect(rows[0]?.command).toBe('mcp-lens.openWalkthrough');
  });

  // It belongs to no group, so the provider renders it above every group header rather than inside one.
  it('carries no group, so it is not buried under a group header', () => {
    const rows = buildSetupRows({ ...base, walkthroughOpened: false });
    expect(rows[0]?.group).toBeUndefined();
  });

  // A permanent row would cost a line forever for something read once, pushing the matrix down.
  it('disappears once the walkthrough has been opened', () => {
    const rows = buildSetupRows({ ...base, walkthroughOpened: true });
    expect(rows.some((row) => row.label === 'Get started')).toBe(false);
  });

  // Without an explicit empty argument list the provider passes { serverName: 'Get started' }.
  it('passes no arguments, unlike the server rows', () => {
    const row = buildSetupRows({ ...base, walkthroughOpened: false })[0];
    expect(row?.commandArgs).toEqual([]);
  });
});
