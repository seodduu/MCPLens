import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildTree } from '../src/matrixTree.js';
import type { EngineInput, ManagedServer } from '@mcp-lens/core';

const call = (sessionId: string, server: string, tool: string, isError = false) => ({
  sessionId, serverName: server, toolName: tool, calledAt: '2026-07-10T00:00:00Z',
  durationMs: null, isError, responseTokens: 50, responseText: null });
const session = (sessionId: string, client: any) => ({
  sessionId, client, filePath: '/f', startedAt: '2026-07-10T00:00:00Z',
  mode: 'DEFERRED_MEASURABLE' as const });

describe('buildTree', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('c1', 'github', 'get_file'),
            call('x1', 'node_repl', 'js')],
    loads: [],
    sessions: [session('c1', 'claude-code'), session('x1', 'codex')],
  };

  it('builds the three-level client / server / tool structure', () => {
    const roots = buildTree(input);
    // The fixture has no definition snapshot, so the last row is the scan hint.
    expect(roots.filter((r) => r.kind !== 'hint').map((r) => r.label))
      .toEqual(['claude-code', 'codex']);
    const claude = roots[0];
    expect(claude.kind).toBe('client');
    expect(claude.children).toHaveLength(1);           // one github server
    expect(claude.children[0].label).toBe('github');
    expect(claude.children[0].children.map((t) => t.label).sort())
      .toEqual(['get_file', 'search']);
  });

  it('puts the call count and response tokens in the tool node description', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.description).toContain('1 call');
    expect(tool.description).toContain('50 tokens');
  });

  // Recommendations are carried by icons alone: a word repeated per tool pushes the numbers aside.
  it('writes no recommendation text, so no trailing separator is left', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.action).toBe('keep');
    expect(tool.description).not.toContain('keep');
    expect(tool.description).not.toMatch(/·\s*$/);  // no trailing separator where the label was removed
  });

  it('puts the session count in the client node description', () => {
    expect(buildTree(input)[0].description).toContain('1');
  });

  it('adds analysis status but exposes global disable only for independent tools', () => {
    const rows = [
      { serverName: 'github', toolName: 'search', status: 'Independent' as const, summary: 'Searches repositories.', action: 'Disable globally…' as const, canDisableGlobally: true },
      { serverName: 'github', toolName: 'get_file', status: 'Dependent' as const, canDisableGlobally: false },
    ];
    const tools = buildTree(input, new Set(), [], new Set(), rows, 'all', () => true)[0].children[0].children;
    const search = tools.find((tool) => tool.toolName === 'search')!;
    const getFile = tools.find((tool) => tool.toolName === 'get_file')!;
    expect(search).toMatchObject({ analysisStatus: 'Independent', analysisSummary: 'Searches repositories.', analysisAction: 'Disable globally…', canDisableGlobally: true });
    expect(getFile).toMatchObject({ analysisStatus: 'Dependent', canDisableGlobally: false });
    expect(getFile.analysisAction).toBeUndefined();
  });

  // A summary often restates status at greater length and is the longest piece on the line, pushing numbers aside.
  it('keeps the summary off the row: only status stays, the summary lives in the details view', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      summary: 'Tool search operates independently without being used by other tools.',
      canDisableGlobally: true }];
    const search = buildTree(input, new Set(), [], new Set(), rows)[0].children[0].children
      .find((tool) => tool.toolName === 'search')!;
    expect(search.description).toContain('Independent');
    expect(search.description).not.toContain('operates independently');
    expect(search.analysisSummary).toBe(rows[0].summary);  // it is still kept for the details view
  });

  it('hides action rows during off rollout', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'off')[0].children[0].children
      .find((row) => row.toolName === 'search')!;
    expect(tool.canDisableGlobally).toBe(false);
    expect(tool.analysisAction).toBeUndefined();
  });

  it.each(['low confidence', 'called', 'degraded collection', 'recent restore'])
  ('hides the action context for %s eligibility failure', (reason) => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'all', () => false)[0].children[0].children
      .find((row) => row.toolName === 'search')!;
    expect(tool.canDisableGlobally, reason).toBe(false);
    expect(tool.analysisAction, reason).toBeUndefined();
  });

  it('exposes the action context for a currently eligible candidate', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'all', () => true)[0].children[0].children
      .find((row) => row.toolName === 'search')!;
    expect(tool.canDisableGlobally).toBe(true);
    expect(tool.analysisAction).toBe('Disable globally…');
  });

  it('exposes restore only for an active Lens-owned action, even when disable eligibility changed', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'all', () => false,
      (client, server, toolName) => client === 'claude-code' && server === 'github' && toolName === 'search')
      [0].children[0].children.find((row) => row.toolName === 'search')!;
    expect(tool).toMatchObject({ canDisableGlobally: false, canRestoreGlobally: true, analysisAction: 'Restore globally' });
  });

  it('hides both global action contexts for active actions during off rollout', () => {
    const rows = [{ serverName: 'github', toolName: 'search', status: 'Independent' as const,
      action: 'Disable globally…' as const, canDisableGlobally: true }];
    const tool = buildTree(input, new Set(), [], new Set(), rows, 'off', () => true, () => true)
      [0].children[0].children.find((row) => row.toolName === 'search')!;
    expect(tool).toMatchObject({ canDisableGlobally: false, canRestoreGlobally: false });
    expect(tool.analysisAction).toBeUndefined();
  });

  it('does not expose legacy tool or server actions in the v2 matrix menu', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const matrixCommands = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('view == mcpLens.matrix'))
      .map((item: { command: string }) => item.command);
    expect(matrixCommands).not.toEqual(expect.arrayContaining([
      'mcp-lens.removeTool', 'mcp-lens.addTool',
      'mcp-lens.removeServer', 'mcp-lens.addServer',
    ]));
  });

  it('uses distinct manifest contexts for disable and restore', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const matrixItems = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('view == mcpLens.matrix'));
    expect(matrixItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'mcplens.disableGlobally', when: expect.stringContaining('mcpAnalysis-disable') }),
      expect.objectContaining({ command: 'mcplens.restoreGlobally', when: expect.stringContaining('mcpAnalysis-restore') }),
    ]));
  });

  // Both actions are visible on row hover (they are not hidden in the right-click menu).
  it('exposes both matrix actions inline on hover', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const matrixItems = manifest.contributes.menus['view/item/context']
      .filter((item: { when?: string }) => item.when?.includes('view == mcpLens.matrix'));
    for (const command of ['mcplens.disableGlobally', 'mcplens.restoreGlobally']) {
      expect(matrixItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ command, group: 'inline' }),
      ]));
    }
  });

  // Measured regression: a configured server creates a "0 calls · 0 tokens" row, so the tree is never
  // empty and the viewsWelcome in package.json never appears. This hint row fills the gap where the
  // first-install screen was a row of zeros that never said what to do next.
  it('appends the scan hint before a scan (no definition snapshot)', () => {
    const roots = buildTree(input);
    const hint = roots.find((r) => r.kind === 'hint');
    expect(hint).toBeDefined();
    expect(hint!.label).toContain('Run a scan');
    expect(roots[roots.length - 1]).toBe(hint);   // preserves the existing "first row is a client" contract
  });

  it('appends no hint after a scan', () => {
    const scanned: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    expect(buildTree(scanned).some((r) => r.kind === 'hint')).toBe(false);
  });

  it('shows definition tokens as accumulated cost even for a tool only loaded, never called', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(loadedOnly)[0].children[0].children[0];
    expect(tool.description).toContain('3,287 tokens');
    expect(tool.description).not.toContain('0 tokens');
  });

  it('marks a tool only loaded, never called as searchedNotCalled', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(loadedOnly)[0].children[0].children[0];
    expect(tool.searchedNotCalled).toBe(true);
  });

  it('does not mark a called tool as searchedNotCalled', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js (called)
    expect(tool.searchedNotCalled).toBeFalsy();
  });

  it('multiplies the definition cost by the number of load sessions', () => {
    const threeSessions: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 1000, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: ['c1', 'c2', 'c3'].map((s) => ({ sessionId: s, serverName: 'notion',
        toolName: 'notion-update-page', loadedTokens: null })),
      sessions: [session('c1', 'claude-code'), session('c2', 'claude-code'),
        session('c3', 'claude-code')],
    };
    const tool = buildTree(threeSessions)[0].children[0].children[0];
    expect(tool.description).toContain('3,000 tokens');
  });

  it('infers the definition cost from the calling session count when there are no load records', () => {
    const hookOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-search',
        definitionTokens: 1721, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [call('c1', 'notion', 'notion-search'), call('c2', 'notion', 'notion-search')],
      loads: [],
      sessions: [session('c1', 'claude-code'), session('c2', 'claude-code')],
    };
    const tool = buildTree(hookOnly)[0].children[0].children[0];
    // definition 1721 x 2 sessions = 3442, responses 50 x 2 calls = 100, total 3542
    expect(tool.description).toContain('3,542 tokens');
  });

  // Unmeasured = the value without definition tokens = a lower bound. One >= says the same thing as a long parenthetical.
  it('shows the response part as a lower bound (>=) when definition tokens are unmeasured', () => {
    const tool = buildTree(input)[1].children[0].children[0]; // codex/node_repl/js
    expect(tool.description).toContain('≥50 tokens');
    expect(tool.description).not.toContain('not measured');
  });

  it('writes no recommendation text: the verdict leaves only through the action field and the icon carries it', () => {
    const lowConfidence: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(lowConfidence)[0].children[0].children[0];
    expect(tool).toMatchObject({ action: 'remove', confidence: 'low' });
    expect(tool.description).not.toContain('remove');
    expect(tool.description).not.toContain('candidate');
  });

  it('shows the child sum, not 0, on the client node when a tool is only loaded and never called', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const [clientNode] = buildTree(loadedOnly);
    const toolNode = clientNode.children[0].children[0];
    // A collapsed client node must not contradict its children (tools): it must use the same
    // accumulated-cost fold as the server and tool nodes, not the response token sum (0).
    expect(clientNode.description).toContain('3,287 tokens');
    expect(clientNode.description).not.toContain('0 tokens');
    expect(clientNode.description).toContain(toolNode.description.match(/[\d,.]+k? tokens/)![0]);
  });

  it('makes the server node accumulated cost equal the sum of its child tools', () => {
    const twoTools: EngineInput = {
      definitions: [
        { serverName: 'notion', toolName: 'notion-update-page', definitionTokens: 3287,
          scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' },
        { serverName: 'notion', toolName: 'notion-create-pages', definitionTokens: 2526,
          scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' },
      ],
      calls: [],
      loads: [
        { sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page', loadedTokens: null },
        { sessionId: 'c1', serverName: 'notion', toolName: 'notion-create-pages', loadedTokens: null },
      ],
      sessions: [session('c1', 'claude-code')],
    };
    const server = buildTree(twoTools)[0].children[0];
    expect(server.description).toContain('5,813 tokens');   // 3287 + 2526
  });
});

describe('descending cost ordering', () => {
  const def = (server: string, tool: string, tokens: number) => ({
    serverName: server, toolName: tool, definitionTokens: tokens,
    scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' });
  const load = (server: string, tool: string) => ({
    sessionId: 'c1', serverName: server, toolName: tool, loadedTokens: null });

  // It must sort opposite to the order of appearance (small then big).
  const input: EngineInput = {
    definitions: [def('small', 'a', 100), def('big', 'x', 9000), def('big', 'y', 500)],
    calls: [],
    loads: [load('small', 'a'), load('big', 'x'), load('big', 'y')],
    sessions: [session('c1', 'claude-code')],
  };

  it('places servers in descending cost order', () => {
    const [client] = buildTree(input);
    expect(client.children.map((s) => s.label)).toEqual(['big', 'small']);
  });

  it('places tools inside a server in descending cost order too', () => {
    const big = buildTree(input)[0].children.find((s) => s.label === 'big')!;
    expect(big.children.map((t) => t.label)).toEqual(['x', 'y']);
  });

  it('places a managed server with no usage history last, since it is 0 tokens', () => {
    const [client] = buildTree(input, new Set(), [{ name: 'idle', enabled: true, origins: ['user'] }]);
    expect(client.children.map((s) => s.label)).toEqual(['big', 'small', 'idle']);
  });

  it('breaks ties by name ascending, so positions do not jitter between refreshes', () => {
    const tie: EngineInput = {
      definitions: [def('zeta', 'a', 500), def('alpha', 'a', 500)],
      calls: [], loads: [load('zeta', 'a'), load('alpha', 'a')],
      sessions: [session('c1', 'claude-code')],
    };
    expect(buildTree(tie)[0].children.map((s) => s.label)).toEqual(['alpha', 'zeta']);
  });
});

describe('token abbreviation', () => {
  const oneTool = (tokens: number): EngineInput => ({
    definitions: [{ serverName: 'notion', toolName: 'big', definitionTokens: tokens,
      scannedAt: '2026-07-19T00:00:00Z', firstScannedAt: '2026-07-19T00:00:00Z' }],
    calls: [],
    loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'big', loadedTokens: null }],
    sessions: [session('c1', 'claude-code')],
  });

  it('shortens 10,000 and up with k: the tree is proportional, so long digit runs do not help comparison', () => {
    const tool = buildTree(oneTool(126_604))[0].children[0].children[0];
    expect(tool.description).toContain('126.6k tokens');
    expect(tool.description).not.toContain('126,604');
  });

  it('keeps full digits under 10,000', () => {
    const tool = buildTree(oneTool(9_999))[0].children[0].children[0];
    expect(tool.description).toContain('9,999 tokens');
  });
});

describe('aggregate display', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('c1', 'github', 'get_file')],
    loads: [],
    sessions: [session('c1', 'claude-code')],
  };
  it('puts the total call count and response token sum on the client node', () => {
    const client = buildTree(input)[0];
    expect(client.description).toContain('total 2 calls');
    expect(client.description).toContain('100 tokens'); // 50 + 50
  });
  it('puts the call count and response token sum on the server node', () => {
    const server = buildTree(input)[0].children[0];
    // The unmeasured marker belongs on tool nodes only: repeated on parents it becomes noise
    expect(server.description).toBe('2 calls · 100 tokens');
  });

  it('never shows the unmeasured marker on server or client nodes', () => {
    const roots = buildTree(input);
    expect(roots[0].description).not.toContain('≥');
    expect(roots[0].children[0].description).not.toContain('≥');
    // It stays on the tool node
    expect(roots[0].children[0].children[0].description).toContain('≥');
  });
});

describe('failure display (only failures in parentheses)', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'flaky', true), call('c1', 'github', 'flaky', true),
            call('c1', 'github', 'ok')],
    loads: [],
    sessions: [session('c1', 'claude-code')],
  };
  it('shows (N failed) on tools, servers and clients that have failures', () => {
    const client = buildTree(input)[0];
    expect(client.description).toContain('total 3 calls (2 failed)');
    expect(client.children[0].description).toContain('3 calls (2 failed)');
    const flaky = client.children[0].children.find((t) => t.label === 'flaky')!;
    expect(flaky.description).toContain('2 calls (2 failed)');
  });
  it('leaves tools with 0 failures clean, without parentheses', () => {
    const ok = buildTree(input)[0].children[0].children.find((t) => t.label === 'ok')!;
    expect(ok.description).toContain('1 call ·');
    expect(ok.description).not.toContain('failed');
  });
});

describe('deny toggle display', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('c1', 'github', 'get_file'),
            call('x1', 'github', 'search')],
    loads: [],
    sessions: [session('c1', 'claude-code'), session('x1', 'codex')],
  };
  const denied = new Set(['mcp__github__search']);

  it('fills client/serverName/toolName on claude-code tool nodes', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'search')!;
    expect(tool.client).toBe('claude-code');
    expect(tool.serverName).toBe('github');
    expect(tool.toolName).toBe('search');
  });
  it('marks a denied claude-code tool enabled=false and blocked in the description', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'search')!;
    expect(tool.enabled).toBe(false);
    expect(tool.description).toContain('Disabled');
  });
  it('marks a claude-code tool that is not denied enabled=true', () => {
    const tool = buildTree(input, denied)[0].children[0].children
      .find((t) => t.label === 'get_file')!;
    expect(tool.enabled).toBe(true);
    expect(tool.description).not.toContain('Disabled');
  });
  it('leaves codex tools enabled=undefined even for the same server and tool (out of scope)', () => {
    const codexTool = buildTree(input, denied)[1].children[0].children[0];
    expect(codexTool.enabled).toBeUndefined();
  });
  it('keeps the existing behaviour when deniedRules is omitted (everything enabled=true)', () => {
    const tool = buildTree(input)[0].children[0].children[0];
    expect(tool.enabled).toBe(true);
  });
});

describe('per-server toggle display', () => {
  const input: EngineInput = {
    definitions: [],
    calls: [call('c1', 'github', 'search'), call('x1', 'github', 'search')],
    loads: [],
    sessions: [session('c1', 'claude-code'), session('x1', 'codex')],
  };
  const m = (name: string, enabled: boolean): ManagedServer =>
    ({ name, enabled, origins: ['user'] });

  // Measured regression: a first-time user before hook installation has zero usage records right
  // after a scan. The old code hardcoded "0 calls · 0 tokens", threw away the definition tokens just
  // measured and carried no tools. A tool that scans and then shows 0 has no reason to be used.
  it('carries the scanned definition tokens and tool list even with no usage records', () => {
    const scannedOnly: EngineInput = {
      definitions: [
        { serverName: 'lenstest', toolName: 'get_weather', definitionTokens: 74,
          scannedAt: '2026-08-05T00:00:00Z', firstScannedAt: '2026-08-05T00:00:00Z' },
        { serverName: 'lenstest', toolName: 'get_forecast', definitionTokens: 84,
          scannedAt: '2026-08-05T00:00:00Z', firstScannedAt: '2026-08-05T00:00:00Z' },
      ],
      calls: [], loads: [], sessions: [],
    };
    const client = buildTree(scannedOnly, new Set(), [m('lenstest', true)])[0];
    expect(client.description).toContain('definition 158 tokens');   // 74 + 84
    const server = client.children[0];
    expect(server.description).toContain('definition 158 tokens');
    expect(server.description).not.toContain('0 tokens');
    // Bigger definitions come first
    expect(server.children.map((t) => t.label)).toEqual(['get_forecast', 'get_weather']);
    expect(server.children[0].description).toContain('definition 84 tokens');
  });

  it('says 0 tokens plainly when there is neither a definition nor usage records', () => {
    const nothing: EngineInput = { definitions: [], calls: [], loads: [], sessions: [] };
    const server = buildTree(nothing, new Set(), [m('lenstest', true)])[0].children[0];
    expect(server.description).toContain('0 calls · 0 tokens');
    expect(server.children).toHaveLength(0);
  });

  it('reflects the managed enabled flag on the server node', () => {
    const server = buildTree(input, new Set(), [m('github', true)])[0].children[0];
    expect(server.enabled).toBe(true);
    expect(server.serverName).toBe('github');
  });
  it('marks a disabled server blocked in the description and hides child tool menus (enabled unset)', () => {
    const server = buildTree(input, new Set(), [m('github', false)])[0].children[0];
    expect(server.enabled).toBe(false);
    expect(server.description).toContain('Disabled');
    expect(server.children[0].enabled).toBeUndefined();
  });
  it('leaves a server absent from managed (a claude.ai connector, say) enabled=undefined (no menu)', () => {
    const server = buildTree(input, new Set(), [])[0].children[0];
    expect(server.enabled).toBeUndefined();
  });
  it('does not apply managed to the codex client', () => {
    const server = buildTree(input, new Set(), [m('github', false)])[1].children[0];
    expect(server.enabled).toBeUndefined();
  });
  it('adds a managed server with no usage history as a zero-call node', () => {
    const claude = buildTree(input, new Set(), [m('github', true), m('lenstest', false)])[0];
    const zero = claude.children.find((s) => s.label === 'lenstest')!;
    expect(zero.description).toBe('0 calls · 0 tokens · Disabled');
    expect(zero.enabled).toBe(false);
    expect(zero.children).toEqual([]);
  });
  it('creates the client node with zero-call servers even with no claude-code session', () => {
    const noClaude: EngineInput = { definitions: [], calls: [], loads: [], sessions: [] };
    const roots = buildTree(noClaude, new Set(), [m('lenstest', true)]);
    const claude = roots.find((r) => r.id === 'claude-code')!;
    expect(claude.description).toContain('0 sessions');
    expect(claude.children.map((s) => s.label)).toEqual(['lenstest']);
  });
});

describe('waste count display', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const upfront = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const def = (tool: string, tokens: number) => ({
    serverName: 'notion', toolName: tool, definitionTokens: tokens,
    scannedAt: at(0), firstScannedAt: at(0) });

  it('appends the wasteful tool count to the server node description', () => {
    const [client] = buildTree({
      definitions: [def('a', 800), def('b', 800)], calls: [], loads: [], sessions: upfront(12) });
    expect(client.children[0].description).toContain('2 wasteful tools');
  });

  it('appends the wasteful tool total to the client node description', () => {
    const [client] = buildTree({
      definitions: [def('a', 800), def('b', 800)], calls: [], loads: [], sessions: upfront(12) });
    expect(client.description).toContain('2 wasteful tools');
  });

  it('shows no waste wording on servers and clients with 0 waste', () => {
    const noWaste: EngineInput = {
      definitions: [], calls: [call('c1', 'github', 'search')], loads: [],
      sessions: [session('c1', 'claude-code')] };
    const [client] = buildTree(noWaste);
    expect(client.description).not.toContain('waste');
    expect(client.children[0].description).not.toContain('waste');
  });
});

describe('per-session definition charge on upfront clients', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const upfront = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'gemini-cli' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const def = (tool: string, tokens: number) => ({
    serverName: 'tiny', toolName: tool, definitionTokens: tokens,
    scannedAt: at(0), firstScannedAt: at(0) });

  const upcall = (sessionId: string, tool: string) => ({
    sessionId, serverName: 'tiny', toolName: tool, calledAt: at(0),
    durationMs: null, isError: false, responseTokens: 50, responseText: null });

  it('shows an uncalled upfront tool as a per-session definition charge, not 0', () => {
    // With no load events loadSessions=0, so the accumulation would be 0 tokens, yet it is loaded every session.
    const [client] = buildTree({
      definitions: [def('a', 800)], calls: [], loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).toContain('800 tokens/session');
  });

  // "3 calls · calls 0 tokens" states the calls twice while carrying an empty 0.
  it('drops the call cost piece entirely when response tokens are 0', () => {
    const [client] = buildTree({
      definitions: [def('a', 800)], calls: [], loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).not.toContain('calls 0 tokens');
    // With one side left the label is unnecessary too: /session already marks the definition
    expect(tool.description).not.toContain('definition ');
  });

  it('keeps call cost accumulated rather than per session: it is not multiplied by sessions', () => {
    // a is called 3 times across 2 sessions (responses 50x3=150 accumulated). The definition is 800 per session.
    const [client] = buildTree({
      definitions: [def('a', 800)],
      calls: [upcall('s0', 'a'), upcall('s0', 'a'), upcall('s1', 'a')],
      loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).toContain('calls 150 tokens');     // 50x3 accumulated
    expect(tool.description).toContain('definition 800 tokens/session'); // not multiplied by sessions
    expect(tool.description).not.toContain('4,000');       // not 800x5
  });

  it('separates calls from definitions on the server and client rollups too', () => {
    const [client] = buildTree({
      definitions: [def('a', 800), def('b', 200)], calls: [], loads: [], sessions: upfront(5) });
    expect(client.children[0].description).toContain('1,000 tokens/session'); // 800+200
    expect(client.description).toContain('1,000 tokens/session');
  });

  it('shows even a 1-token dummy definition as 1 token/session rather than 0', () => {
    const [client] = buildTree({
      definitions: [def('a', 1), def('b', 1), def('c', 1)], calls: [], loads: [],
      sessions: upfront(5) });
    for (const t of client.children[0].children)
      expect(t.description).toContain('1 token/session');
  });

  it('shows only "definition unmeasured" rather than 0 tokens/session for an unmeasured tool', () => {
    // A tool the scanner missed is called under upfront, so its definition tokens are null.
    const [client] = buildTree({
      definitions: [], calls: [upcall('s0', 'a')], loads: [], sessions: upfront(5) });
    const tool = client.children[0].children[0];
    expect(tool.description).toContain('calls 50 tokens');
    expect(tool.description).toContain('definition unmeasured');
    expect(tool.description).not.toContain('0 tokens/session');
    expect(tool.description).not.toContain('definition 0 tokens');
  });

  it('still shows deferred-loading clients as a single accumulated value (no /session or call labels): regression', () => {
    const loadedOnly: EngineInput = {
      definitions: [{ serverName: 'notion', toolName: 'notion-update-page',
        definitionTokens: 3287, scannedAt: '2026-07-19T00:00:00Z',
        firstScannedAt: '2026-07-19T00:00:00Z' }],
      calls: [],
      loads: [{ sessionId: 'c1', serverName: 'notion', toolName: 'notion-update-page',
        loadedTokens: null }],
      sessions: [session('c1', 'claude-code')],
    };
    const tool = buildTree(loadedOnly)[0].children[0].children[0];
    expect(tool.description).toContain('3,287 tokens');
    expect(tool.description).not.toContain('/session');
    expect(tool.description).not.toContain('calls 0 tokens'); // deferred loading stays a single accumulated value
  });
});

describe('hiding unsupported servers (excludeServers)', () => {
  const m = (name: string, enabled: boolean): ManagedServer =>
    ({ name, enabled, origins: ['user'] });

  it('drops a server in excludeServers from the tree even with usage history', () => {
    const input: EngineInput = {
      definitions: [],
      calls: [call('c1', 'github', 'search'), call('c1', 'figma', 'get_file')],
      loads: [],
      sessions: [session('c1', 'claude-code')],
    };
    const [claude] = buildTree(input, new Set(), [], new Set(['figma']));
    expect(claude.children.map((s) => s.label)).toEqual(['github']);
  });

  it('never shows a server in excludeServers as a zero-call managed node either', () => {
    const input: EngineInput = { definitions: [], calls: [], loads: [], sessions: [] };
    const roots = buildTree(input, new Set(), [m('figma', true), m('github', true)], new Set(['figma']));
    const claude = roots.find((r) => r.id === 'claude-code')!;
    expect(claude.children.map((s) => s.label)).toEqual(['github']);
  });

  it('keeps the existing behaviour when excludeServers is omitted', () => {
    const input: EngineInput = {
      definitions: [], calls: [call('c1', 'figma', 'x')], loads: [],
      sessions: [session('c1', 'claude-code')] };
    const [claude] = buildTree(input);
    expect(claude.children.map((s) => s.label)).toEqual(['figma']);
  });
});

describe('confidence rendering', () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(Date.parse('2026-06-01T00:00:00Z') + d * DAY).toISOString();
  const sess = (n: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client: 'claude-code' as const, filePath: `/f/${i}`,
    startedAt: at(i), mode: 'UPFRONT' as const }));
  const unusedDef = {
    serverName: 'github', toolName: 'unused', definitionTokens: 800,
    scannedAt: at(0), firstScannedAt: at(0) };

  const toolNode = (sessionCount: number) => {
    const [client] = buildTree({
      definitions: [unusedDef], calls: [], loads: [], sessions: sess(sessionCount) });
    return client.children[0].children[0];
  };

  it('reports high confidence for a high-confidence remove', () => {
    const node = toolNode(12);
    expect(node.confidence).toBe('high');
    expect(node.action).toBe('remove');
  });

  // With low confidence lensTreeProvider suppresses the recommendation icon itself: the demotion is never written out.
  it('reports low confidence for a low-confidence remove', () => {
    const node = toolNode(2);
    expect(node.confidence).toBe('low');
    expect(node.description).not.toContain('candidate');
  });

  // If splitByClient dropped lastCallByTool, this tool would look never used and come back high.
  it('stays medium (not high) with past calls outside the window: lastCallByTool reaches the engine', () => {
    const [client] = buildTree({
      definitions: [unusedDef], calls: [], loads: [], sessions: sess(12),
      lastCallByTool: new Map([['github unused', '2026-03-14T09:00:00Z']]),
    });
    const node = client.children[0].children[0];
    expect(node.action).toBe('remove');
    expect(node.confidence).toBe('medium');
    expect(node.confidence).not.toBe('high');
    expect(node.description).not.toContain('candidate');
  });
});
