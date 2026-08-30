// packages/core/test/engine/serverVerdict.test.ts
import { describe, it, expect } from 'vitest';
import type { EngineInput } from '../../src/engine/engine.js';
import { buildServerVerdicts, serverRemoveConfidence } from '../../src/engine/serverVerdict.js';
import type { AccountingMode, ClientId, ServerContextOverhead, ServerEvidence, SessionMeta,
  ToolCallEvent, ToolDefinition, ToolLoadEvent } from '../../src/types.js';

const DAY = 86_400_000;
const iso = (dayOffset: number) =>
  new Date(Date.parse('2026-06-01T00:00:00Z') + dayOffset * DAY).toISOString();

/** Builds n sessions one day apart (s0 = day0, s1 = day1, ...) */
const sessions = (n: number, mode: AccountingMode = 'DEFERRED_MEASURABLE',
  client: ClientId = 'claude-code'): SessionMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`, client, filePath: `/f/${i}`, startedAt: iso(i), mode }));

const def = (serverName: string, toolName: string, firstScannedAt = iso(0),
  definitionTokens = 800): ToolDefinition => ({
  serverName, toolName, definitionTokens, advertisedTokens: null, estimatorVersion: 'v2',
  scannedAt: iso(9), firstScannedAt });

const jiraDefs = (firstScannedAt = iso(0)) =>
  ['t1', 't2', 't3'].map((t) => def('jira', t, firstScannedAt));

const call = (sessionId: string, toolName: string, calledAt: string | null,
  serverName = 'jira'): ToolCallEvent => ({
  sessionId, serverName, toolName, calledAt, durationMs: 1, isError: false,
  responseTokens: 10, responseText: null });

const load = (sessionId: string, toolName: string, serverName: string | null = 'jira'):
  ToolLoadEvent => ({ sessionId, serverName, toolName, loadedTokens: null });

const overhead = (serverName: string, instructionsTokens: number): ServerContextOverhead => ({
  serverName, instructionsTokens, instructionsSha256: 'sha', estimatorVersion: 'v2',
  scannedAt: iso(9) });

const input = (over: Partial<EngineInput> = {}): EngineInput => ({
  definitions: jiraDefs(), calls: [], loads: [], sessions: sessions(10), ...over });

const evidence = (over: Partial<ServerEvidence> = {}): ServerEvidence => ({
  configuredSessions: 0, datedConfiguredSessions: 0, loadedSessions: 0, calledSessions: 0,
  observedDays: null, lastActivityAt: null, ...over });

describe('buildServerVerdicts (design 2026-08-31 section 3.3)', () => {
  it('server never loaded or called under deferred loading is remove-server, counting every configured session', () => {
    const [v] = buildServerVerdicts(input());
    expect(v.serverName).toBe('jira');
    expect(v.action).toBe('remove-server');
    expect(v.evidence.configuredSessions).toBe(10);
    expect(v.evidence.datedConfiguredSessions).toBe(10);
    expect(v.evidence.observedDays).toBe(9);
    expect(v.confidence).toBe('high');
    expect(v.unmeasuredNameListEntries).toBe(3);
    expect(v.measuredPerSessionTokens).toBe(0);
    expect(v.reason).toContain('never loaded or called in 10 sessions/9d');
  });

  it('instructions overhead is the measured saving under deferred loading', () => {
    const [v] = buildServerVerdicts(input({ serverOverheads: [overhead('jira', 120)] }));
    expect(v.measuredPerSessionTokens).toBe(120);
    expect(v.unmeasuredNameListEntries).toBe(3);
    expect(v.reason).toContain('Removing saves about 120 tokens per session'
      + ' plus 3 name-list entries (unmeasured)');
  });

  it('definitions plus instructions under upfront loading', () => {
    const [v] = buildServerVerdicts(input({
      sessions: sessions(10, 'UPFRONT'), serverOverheads: [overhead('jira', 120)] }));
    expect(v.action).toBe('remove-server');
    expect(v.measuredPerSessionTokens).toBe(2520); // 800 x 3 + 120
    expect(v.unmeasuredNameListEntries).toBe(0);
    expect(v.reason).toContain('Removing saves about 2,520 tokens per session');
    expect(v.reason).not.toContain('name-list entries');
  });

  it('one load anywhere in the window keeps the server', () => {
    const [v] = buildServerVerdicts(input({ loads: [load('s4', 't1')] }));
    expect(v.action).toBe('keep');
    expect(v.confidence).toBe('high');
    expect(v.evidence.loadedSessions).toBe(1);
    expect(v.evidence.calledSessions).toBe(0);
    expect(v.reason).toBe('loaded in 1 sessions, never called');
    expect(v.evidence.lastActivityAt).toBe(iso(4));
  });

  it('a call keeps the server and names the session count', () => {
    const [v] = buildServerVerdicts(input({
      calls: [call('s2', 't1', iso(2)), call('s5', 't2', iso(5))] }));
    expect(v.action).toBe('keep');
    expect(v.evidence.calledSessions).toBe(2);
    expect(v.reason).toBe('called in 2 sessions');
    expect(v.evidence.lastActivityAt).toBe(iso(5));
  });

  it('all-time call history outside the window keeps the server', () => {
    const [v] = buildServerVerdicts(input({
      lastCallByTool: new Map([['jira t1', iso(-40)]]) }));
    expect(v.action).toBe('keep');
    expect(v.evidence.loadedSessions).toBe(0);
    expect(v.evidence.calledSessions).toBe(0);
    expect(v.evidence.lastActivityAt).toBe(iso(-40));
  });

  it('configured sessions follow serversByClient when present', () => {
    const mixed = sessions(10).map((s, i) =>
      i >= 6 ? { ...s, client: 'codex' as ClientId } : s);
    const [v] = buildServerVerdicts(input({
      sessions: mixed,
      serversByClient: new Map([['claude-code' as ClientId, new Set(['jira'])]]) }));
    expect(v.evidence.configuredSessions).toBe(6);
    expect(v.evidence.datedConfiguredSessions).toBe(6);
  });

  it('opaque sessions never count', () => {
    const [v] = buildServerVerdicts(input({ sessions: sessions(10, 'DEFERRED_OPAQUE') }));
    expect(v.evidence.configuredSessions).toBe(0);
    expect(v.evidence.observedDays).toBeNull();
    expect(v.confidence).toBe('low');
  });
});

describe('serverRemoveConfidence grades', () => {
  it('grades', () => {
    expect(serverRemoveConfidence(evidence({
      configuredSessions: 4, datedConfiguredSessions: 4, observedDays: 9 }))).toBe('low');
    expect(serverRemoveConfidence(evidence({
      configuredSessions: 6, datedConfiguredSessions: 6, observedDays: 3 }))).toBe('medium');
    expect(serverRemoveConfidence(evidence({
      configuredSessions: 10, datedConfiguredSessions: 10, observedDays: 7 }))).toBe('high');
  });
});
