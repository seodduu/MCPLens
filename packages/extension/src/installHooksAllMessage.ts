import type { ClientRowInput } from './hookStatusProvider.js';

/**
 * mcp-lens.installHooksAll 커맨드가 보여줄 안내 메시지를 판정하는 순수 함수.
 * vscode API를 참조하지 않아 단위테스트에서 바로 검증할 수 있다.
 */

/** targets(설치 대상)가 비었을 때 보여줄 메시지. */
export function noInstallTargetsMessage(inputs: ClientRowInput[]): string {
  const pendingApproval = inputs.find((input) => input.install === 'needs-approval');
  if (pendingApproval) {
    return `MCP Lens: approval for ${pendingApproval.client} is pending. `
      + `Open ${pendingApproval.client}'s /hooks and approve the MCP Lens hooks to continue.`;
  }
  return 'MCP Lens: hooks are already installed.';
}

/** 설치를 시도한 뒤 보여줄 결과 메시지. 전부 실패하면 "installed hooks for" 절을 아예 뺀다. */
export function installedSummaryMessage(installed: string[], failedCount: number): string {
  if (installed.length === 0) return `MCP Lens: hook installation failed (${failedCount} failed).`;
  const failedNote = failedCount > 0 ? ` ${failedCount} failed.` : '';
  return `MCP Lens: installed hooks for ${installed.join(', ')}.${failedNote}`;
}
