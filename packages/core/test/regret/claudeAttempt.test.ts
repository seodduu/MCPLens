import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { decodeClaudeHook } from '../../src/ingest/clients/claude/decoder.js';
import type { ToolObservation } from '../../src/ingest/contracts.js';
import { directClaudeRegretSignals } from '../../src/regret/claudeAttempt.js';
import type { GlobalAction } from '../../src/types.js';

const fixture = (name: string): unknown => JSON.parse(
  readFileSync(new URL(`../../../../fixtures/regret/${name}`, import.meta.url), 'utf8'),
);

const action = (overrides: Partial<GlobalAction> = {}): GlobalAction => ({
  actionId: 'action-claude-github-search',
  client: 'claude-code',
  serverName: 'github',
  toolName: 'search_issues',
  identityHash: 'identity-anon',
  definitionSetHash: 'definitions-anon',
  ownedRule: 'mcp__github__search_issues',
  backupPath: '/tmp/mcplens/backup-anon.json',
  preFingerprint: 'pre-anon',
  postFingerprint: 'post-anon',
  status: 'active',
  createdAt: '2026-08-03T00:00:00.000Z',
  restoredAt: null,
  ...overrides,
});

const observationFromFixture = (receivedAt = '2026-08-03T00:00:01.000Z'): ToolObservation => {
  const result = decodeClaudeHook(fixture('claude-active-deny-pre-tool-use.json'), receivedAt);
  if (result.kind !== 'observation') throw new Error(`expected observation, got ${result.kind}`);
  return result.observation;
};

describe('directClaudeRegretSignals', () => {
  test('creates one direct signal for an active Claude action matched by exact PreToolUse observation after action creation', () => {
    const observation = observationFromFixture();

    expect(directClaudeRegretSignals([action()], observation)).toEqual([{
      actionId: 'action-claude-github-search',
      kind: 'direct',
      sessionId: 'claude-session-regret-001',
      observedAt: '2026-08-03T00:00:01.000Z',
    }]);
  });

  test.each([
    ['non-MCP observation', { serverName: null, toolName: null }],
    ['different client observation', { client: 'codex' as const }],
    ['inactive action', {}, { status: 'restored' as const, restoredAt: '2026-08-03T00:00:02.000Z' }],
    ['restored action', {}, { status: 'restore-pending' as const }],
    ['observation before action', { observedAt: '2026-08-02T23:59:59.999Z' }],
    ['substring server name', { serverName: 'github-enterprise' }],
    ['substring tool name', { toolName: 'search_issues_old' }],
  ])('does not create a direct signal for %s', (_name, observationOverrides, actionOverrides = {}) => {
    const observation = { ...observationFromFixture(), ...observationOverrides };

    expect(directClaudeRegretSignals([action(actionOverrides)], observation)).toEqual([]);
  });

  test('uses the same regret signal key for repeated action and session observations', () => {
    const first = directClaudeRegretSignals([action()], observationFromFixture('2026-08-03T00:00:01.000Z'));
    const second = directClaudeRegretSignals([action()], observationFromFixture('2026-08-03T00:00:05.000Z'));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect({
      actionId: second[0]?.actionId,
      kind: second[0]?.kind,
      sessionId: second[0]?.sessionId,
    }).toEqual({
      actionId: first[0]?.actionId,
      kind: first[0]?.kind,
      sessionId: first[0]?.sessionId,
    });
  });

  test.each(['tool-failure', 'tool-after'] as const)(
    'creates a direct signal for a structured Claude log %s after action creation',
    (phase) => {
      const observation = { ...observationFromFixture(), source: 'log' as const, phase };
      expect(directClaudeRegretSignals([action()], observation)).toMatchObject([{
        actionId: 'action-claude-github-search', kind: 'direct',
      }]);
    },
  );

  test('does not treat a generic Claude log tool-before as a direct attempt', () => {
    const observation = { ...observationFromFixture(), source: 'log' as const, phase: 'tool-before' as const };
    expect(directClaudeRegretSignals([action()], observation)).toEqual([]);
  });
});
