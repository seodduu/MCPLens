import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/report.js';
import type { MatrixRow } from '@mcp-lens/core';

const row: MatrixRow = {
  serverName: 'github', toolName: 'unused', definitionTokens: 800,
  callCount: 0, responseTokens: 0, loadedSessionCount: 0, sessionCount: 10,
  recommendation: { action: 'remove', confidence: 'high',
    reason: 'definition 800 tokens, 0 calls', evidenceLabel: 'measured',
    reasonParts: { basis: 'definition 800 tokens, 0 calls', serverBasis: null, effect: null, caveat: null },
    evidence: { observedSessions: 12, datedObservedSessions: 12, observedDays: 20, lastCalledAt: null,
      costPerSession: 800, totalObservedCost: 9600 } },
  reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
  loadPattern: null,
};
const savings = { potentialTokens: 8000, actualTokens: 1200, savedTokens: 6800 };

describe('formatReport', () => {
  it('includes server, tool and recommendation in the table format', () => {
    const out = formatReport([row], savings, 'table');
    expect(out).toContain('github');
    expect(out).toContain('remove');
  });
  it('starts the ai format with # MCP Lens Audit (plugin contract)', () => {
    expect(formatReport([row], savings, 'ai').split('\n')[0]).toBe('# MCP Lens Audit');
  });
  it('emits parsable json', () => {
    const parsed = JSON.parse(formatReport([row], savings, 'json'));
    expect(parsed.rows).toHaveLength(1);
  });
  it('lists inspect rows in the failing-tools section of the ai format', () => {
    const flakyRow: MatrixRow = {
      serverName: 'github', toolName: 'flaky', definitionTokens: 500,
      callCount: 3, responseTokens: 300, loadedSessionCount: 0, sessionCount: 10,
      recommendation: {
        action: 'inspect',
        confidence: 'medium',
        reason: '2 of 3 calls failed (67%), 200 tokens wasted on failed responses. inspect or replace',
        evidenceLabel: 'assumed full load',
        reasonParts: { basis: '2 of 3 calls failed (67%), 200 tokens wasted on failed responses',
          serverBasis: null, effect: 'inspect or replace', caveat: null },
        evidence: { observedSessions: 10, datedObservedSessions: 10, observedDays: 20,
          lastCalledAt: '2026-07-10T00:00:00Z',
          costPerSession: 500, totalObservedCost: 5000 },
      },
      reliability: { errorCount: 2, errorRate: 2 / 3, failedResponseTokens: 200 },
      loadPattern: null,
    };
    const out = formatReport([row, flakyRow], savings, 'ai');
    expect(out).toContain('## Failing tools to inspect');
    expect(out).toContain('github/flaky');
    expect(out).toContain('inspect');
  });
});

describe('ai format reason compression', () => {
  const filterRow = (tool: string, defTokens: number, cost: number): MatrixRow => ({
    serverName: 'notion', toolName: tool, definitionTokens: defTokens, callCount: 0,
    responseTokens: 0, loadedSessionCount: 1, sessionCount: 447,
    recommendation: {
      action: 'filter-server', confidence: 'high',
      reason: 'Only 2 of 27 tools used on server notion. Tool filtering recommended. small savings, but cleans up the search space. '
        + `336 sessions/16d observed, accumulated cost ${cost.toLocaleString('en-US')} tokens. Restorable with one config line`,
      reasonParts: {
        basis: '',
        serverBasis: 'Only 2 of 27 tools used on server notion. Tool filtering recommended.',
        effect: 'small savings, but cleans up the search space',
        caveat: `336 sessions/16d observed, accumulated cost ${cost.toLocaleString('en-US')} tokens. Restorable with one config line`,
      },
      evidenceLabel: 'measured',
      evidence: { observedSessions: 336, datedObservedSessions: 336, observedDays: 16,
        lastCalledAt: null, costPerSession: defTokens, totalObservedCost: cost },
    },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null,
  });
  const rows = [filterRow('a', 3411, 1146096), filterRow('b', 3376, 1134336), filterRow('c', 2543, 854448)];

  it('carries the shared server basis once per server, outside the table', () => {
    const out = formatReport(rows, savings, 'ai');
    const occurrences = out.split('Only 2 of 27 tools used on server notion').length - 1;
    expect(out).toContain('## Shared server basis');
    expect(occurrences).toBe(1);
  });

  it('lifts a repeated tail into a template and leaves only the name and per-row value in the row', () => {
    const out = formatReport(rows, savings, 'ai');
    expect(out).toContain('## Row reason templates');
    expect(out).toContain('- T1: small savings, but cleans up the search space. 336 sessions/16d observed, accumulated cost {cost} tokens. Restorable with one config line');
    // The per-row accumulated cost stays in the row (it is the evidence).
    expect(out).toContain('| T1 (accumulated cost 1,146,096 tokens) |');
    expect(out).toContain('| T1 (accumulated cost 1,134,336 tokens) |');
    expect(out).toContain('| T1 (accumulated cost 854,448 tokens) |');
    // template definition once, not repeated per row
    expect(out.split('Restorable with one config line').length - 1).toBe(1);
  });

  it('keeps action, confidence and numbers intact after compression', () => {
    const out = formatReport(rows, savings, 'ai');
    expect(out).toContain('| notion | a | 3411 | 0 | 0 | 1/447 | - | 0 | filter-server | high |');
    expect(out).toContain('How to read:');
  });

  it('keeps a tail inline when it is used only once', () => {
    const out = formatReport([rows[0]], savings, 'ai');
    expect(out).not.toContain('## Row reason templates');
    expect(out).toContain('accumulated cost 1,146,096 tokens');
  });
});

describe('confidence surfacing', () => {
  const mk = (tool: string, confidence: 'high' | 'medium' | 'low'): MatrixRow => ({
    serverName: 'github', toolName: tool, definitionTokens: 800, callCount: 0,
    responseTokens: 0, loadedSessionCount: 0, sessionCount: 12,
    recommendation: { action: 'remove', confidence,
      reason: `${tool} reason`, evidenceLabel: 'assumed full load',
      reasonParts: { basis: `${tool} reason`, serverBasis: null, effect: null, caveat: null },
      evidence: { observedSessions: 12, datedObservedSessions: 12, observedDays: 20, lastCalledAt: null,
        costPerSession: 800, totalObservedCost: 9600 } },
    reliability: { errorCount: 0, errorRate: null, failedResponseTokens: 0 },
    loadPattern: null,
  });
  const savings = { potentialTokens: 0, actualTokens: 0, savedTokens: 0 };

  it('shows the confidence column in the table format', () => {
    const out = formatReport([mk('a', 'high')], savings, 'table');
    expect(out).toContain('confidence');
    expect(out).toContain('high');
  });

  it('orders ai recommendations by confidence and splits low into a candidate section', () => {
    const out = formatReport(
      [mk('lo', 'low'), mk('hi', 'high'), mk('mid', 'medium')], savings, 'ai');
    expect(out).toContain('### Candidates (not enough observation)');
    // high comes before medium in the confirmed list
    expect(out.indexOf('github/hi')).toBeLessThan(out.indexOf('github/mid'));
    // low comes after the candidate heading
    expect(out.indexOf('### Candidates (not enough observation)')).toBeLessThan(out.indexOf('github/lo'));
  });

  it('says there are no confirmed recommendations when only low rows exist', () => {
    const out = formatReport([mk('lo', 'low')], savings, 'ai');
    expect(out).toContain('No confirmed recommendations');
    expect(out).toContain('github/lo');
  });
});
