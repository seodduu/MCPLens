import { describe, it, expect } from 'vitest';
import { approvalPendingClients, pendingHookClients } from '../src/nudge.js';
import type { HookClient, InstallState } from '../src/hookInstall.js';

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

  it('needs-approval은 설치 대상이 아니라 승인 대상이다', () => {
    const detectedCodex = new Set<HookClient>(['codex']);
    const states = new Map<HookClient, InstallState>([['codex', 'needs-approval']]);
    expect(pendingHookClients(detectedCodex, states, new Set())).toEqual([]);
    expect(approvalPendingClients(detectedCodex, states, new Set())).toEqual(['codex']);
  });

  it('다시 안 보기로 지운 클라이언트는 승인 안내에서도 빠진다', () => {
    const detectedCodex = new Set<HookClient>(['codex']);
    const states = new Map<HookClient, InstallState>([['codex', 'needs-approval']]);
    expect(approvalPendingClients(detectedCodex, states, new Set(['codex']))).toEqual([]);
  });
});
