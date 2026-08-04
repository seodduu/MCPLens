// packages/extension/src/authDecision.ts — vscode import 금지
import type { McpServerSpec } from '@mcp-lens/core';

export type AuthPromptAction =
  | { kind: 'skip' }
  | { kind: 'prompt'; targets: McpServerSpec[] };

/**
 * auth-required(토큰 만료 포함)로 실패한 서버 중 알림 대상을 고른다.
 * - ignoreList: '이 서버는 묻지 않음'으로 영구 무시(설정에 저장)된 서버.
 * - sessionSnoozed: '나중에'로 이번 VSCode 세션 동안만 억제된 서버(재시작 시 초기화).
 * - unsupported: DCR 거부 등으로 Lens가 지원하지 않는다고 판정한 서버(영구, 재프롬프트 금지).
 */
export function decideAuthPrompt(args: {
  failedServers: McpServerSpec[];
  ignoreList: string[];
  sessionSnoozed?: string[];
  unsupported?: string[];
}): AuthPromptAction {
  const suppressed = new Set([
    ...args.ignoreList, ...(args.sessionSnoozed ?? []), ...(args.unsupported ?? []),
  ]);
  const targets = args.failedServers.filter((s) => !suppressed.has(s.name));
  if (targets.length === 0) return { kind: 'skip' };
  return { kind: 'prompt', targets };
}

/**
 * 자동 클라이언트 등록(DCR)을 거부하는 서버인지 판정한다.
 * 등록 엔드포인트가 403 Forbidden을 반환하면(예: Figma) 브라우저가 열리기도 전에 실패한다 —
 * 이런 서버는 Lens가 로그인할 수 없으므로 '지원하지 않는 서버'로 처리한다.
 */
export function isDcrRejected(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /dynamic client registration/i.test(raw) ||
    (/\b403\b/.test(raw) && /forbidden/i.test(raw));
}

/** DCR 거부가 아닌 일반 로그인 실패를 사용자용 문구로 바꾼다. */
export function friendlyAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `Sign-in failed. ${raw}`;
}
