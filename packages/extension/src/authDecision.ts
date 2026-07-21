// packages/extension/src/authDecision.ts — vscode import 금지
import type { McpServerSpec } from '@mcp-lens/core';

export type AuthPromptAction =
  | { kind: 'skip' }
  | { kind: 'prompt'; targets: McpServerSpec[] };

/**
 * auth-required(토큰 만료 포함)로 실패한 서버 중 알림 대상을 고른다.
 * - ignoreList: '이 서버는 묻지 않음'으로 영구 무시(설정에 저장)된 서버.
 * - sessionSnoozed: '나중에'로 이번 VSCode 세션 동안만 억제된 서버(재시작 시 초기화).
 */
export function decideAuthPrompt(args: {
  failedServers: McpServerSpec[];
  ignoreList: string[];
  sessionSnoozed?: string[];
}): AuthPromptAction {
  const suppressed = new Set([...args.ignoreList, ...(args.sessionSnoozed ?? [])]);
  const targets = args.failedServers.filter((s) => !suppressed.has(s.name));
  if (targets.length === 0) return { kind: 'skip' };
  return { kind: 'prompt', targets };
}

/**
 * 로그인 실패 원인을 사용자용 문구로 바꾼다.
 * 자동 클라이언트 등록(DCR)을 거부하는 서버(예: Figma — 등록 엔드포인트가 403 Forbidden)는
 * 브라우저가 열리기도 전에 실패하므로, 왜 안 되는지와 대안(headers 토큰)을 안내한다.
 */
export function friendlyAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const dcrRejected =
    /dynamic client registration/i.test(raw) ||
    (/\b403\b/.test(raw) && /forbidden/i.test(raw));
  if (dcrRejected) {
    return '이 서버는 자동 클라이언트 등록(DCR)을 허용하지 않아 Lens로 로그인할 수 없습니다. ' +
      '설정의 headers 필드에 액세스 토큰을 넣으면 스캔됩니다.';
  }
  return `로그인 실패 — ${raw}`;
}
