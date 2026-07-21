import { describe, it, expect } from 'vitest';
import { pendingHookClients } from '../src/nudge.js';

describe('pendingHookClients', () => {
  const detected = new Set(['claude-code', 'codex', 'gemini-cli'] as const);
  it('미설치이고 dismiss 안 된 클라이언트만', () => {
    const states = new Map([['claude-code', 'installed'], ['codex', 'not-installed'], ['gemini-cli', 'not-installed']] as const);
    const dismissed = new Set(['gemini-cli'] as const);
    expect(pendingHookClients(detected, states, dismissed)).toEqual(['codex']);
  });
  it('client-missing은 제외', () => {
    const states = new Map([['claude-code', 'client-missing'], ['codex', 'not-installed']] as const);
    expect(pendingHookClients(new Set(['claude-code', 'codex'] as const), states, new Set())).toEqual(['codex']);
  });
});
