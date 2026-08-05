import { describe, it, expect } from 'vitest';
import { noInstallTargetsMessage, installedSummaryMessage } from '../src/installHooksAllMessage.js';
import type { ClientRowInput } from '../src/collectionRows.js';

describe('noInstallTargetsMessage', () => {
  it('says everything is already installed when all are installed', () => {
    const inputs = [{ client: 'claude-code', install: 'installed' }] as ClientRowInput[];
    expect(noInstallTargetsMessage(inputs)).toBe('MCP Lens: hooks are already installed.');
  });

  it('switches to approval-pending guidance when a client is needs-approval', () => {
    // installHooksAll picks only 'not-installed' targets, so with a needs-approval client the
    // targets were empty and it wrongly read as "already installed". This state must say hook approval is pending.
    const inputs = [
      { client: 'claude-code', install: 'installed' },
      { client: 'codex', install: 'needs-approval' },
    ] as ClientRowInput[];
    const msg = noInstallTargetsMessage(inputs);
    expect(msg).toContain('codex');
    expect(msg).toContain('pending');
    expect(msg).toContain('/hooks');
    expect(msg).not.toBe('MCP Lens: hooks are already installed.');
  });
});

describe('installedSummaryMessage', () => {
  it('lists the successful client names on a partial success', () => {
    expect(installedSummaryMessage(['claude-code'], 0)).toBe('MCP Lens: installed hooks for claude-code.');
  });

  it('appends the failure count when some succeed and some fail', () => {
    expect(installedSummaryMessage(['claude-code'], 1)).toBe('MCP Lens: installed hooks for claude-code. 1 failed.');
  });

  it('drops the "installed hooks for" clause and reports only failures when everything fails', () => {
    const msg = installedSummaryMessage([], 2);
    expect(msg).not.toContain('installed hooks for');
    expect(msg).toContain('2 failed');
  });
});
