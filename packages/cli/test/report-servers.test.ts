// A server with no load and no call anywhere in the window is server-level evidence: under
// deferred loading no tool row can carry it, so the CLI has to say it on its own line.
import { describe, it, expect } from 'vitest';
import type { MatrixRow, ServerVerdict } from '@mcp-lens/core';
import { formatReport } from '../src/report.js';

const SAVINGS = { potentialTokens: 0, actualTokens: 0, savedTokens: 0, savedRatio: 0 } as never;
const ROWS: MatrixRow[] = [];
const REASON = 'never loaded or called in 10 sessions/9d. Removing saves about 120tok per session '
  + 'plus 3 name-list entries (unmeasured)';
const SERVERS: ServerVerdict[] = [
  {
    serverName: 'jira', action: 'remove-server', confidence: 'high',
    evidence: {
      configuredSessions: 10, datedConfiguredSessions: 10, observedDays: 9,
      loadedSessions: 0, calledSessions: 0, lastActivityAt: null,
    },
    measuredPerSessionTokens: 120, unmeasuredNameListEntries: 3, reason: REASON,
  },
  {
    serverName: 'github', action: 'keep', confidence: 'high',
    evidence: {
      configuredSessions: 10, datedConfiguredSessions: 10, observedDays: 9,
      loadedSessions: 4, calledSessions: 2, lastActivityAt: '2026-08-30T00:00:00.000Z',
    },
    measuredPerSessionTokens: 0, unmeasuredNameListEntries: 0, reason: 'called in 2 sessions',
  },
];

describe('CLI report surfaces server verdicts', () => {
  it('always carries the servers key in json, empty array included', () => {
    const clean = JSON.parse(formatReport(ROWS, SAVINGS, 'json', []));
    expect(clean.servers).toEqual([]);
    const full = JSON.parse(formatReport(ROWS, SAVINGS, 'json', [], SERVERS));
    expect(full.servers).toHaveLength(2);
    expect(full.servers[0].serverName).toBe('jira');
  });

  it('warns above the table for a remove-server verdict only', () => {
    const out = formatReport(ROWS, SAVINGS, 'table', [], SERVERS);
    expect(out).toContain(`! server jira: ${REASON} (high)`);
    expect(out).not.toContain('! server github');
  });

  it('warns in the ai format too', () => {
    const out = formatReport(ROWS, SAVINGS, 'ai', [], SERVERS);
    expect(out).toContain(`! server jira: ${REASON} (high)`);
  });
});
