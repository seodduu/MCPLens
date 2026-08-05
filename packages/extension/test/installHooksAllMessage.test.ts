import { describe, it, expect } from 'vitest';
import { noInstallTargetsMessage, installedSummaryMessage } from '../src/installHooksAllMessage.js';
import type { ClientRowInput } from '../src/collectionRows.js';

describe('noInstallTargetsMessage', () => {
  it('모두 installed면 이미 설치됐다고 안내한다', () => {
    const inputs = [{ client: 'claude-code', install: 'installed' }] as ClientRowInput[];
    expect(noInstallTargetsMessage(inputs)).toBe('MCP Lens: hooks are already installed.');
  });

  it('needs-approval인 클라이언트가 있으면 승인 대기 안내로 바꾼다', () => {
    // installHooksAll의 targets는 'not-installed'만 골라서, needs-approval인 클라이언트가 있으면
    // targets가 비어 "이미 설치됨"으로 잘못 보였다. 이 상태는 정확히 훅 승인 대기를 알려야 한다.
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
  it('일부 성공하면 성공한 클라이언트 이름을 나열한다', () => {
    expect(installedSummaryMessage(['claude-code'], 0)).toBe('MCP Lens: installed hooks for claude-code.');
  });

  it('일부 성공하고 일부 실패하면 실패 개수를 덧붙인다', () => {
    expect(installedSummaryMessage(['claude-code'], 1)).toBe('MCP Lens: installed hooks for claude-code. 1 failed.');
  });

  it('전부 실패하면 "installed hooks for" 절을 빼고 실패만 알린다', () => {
    const msg = installedSummaryMessage([], 2);
    expect(msg).not.toContain('installed hooks for');
    expect(msg).toContain('2 failed');
  });
});
