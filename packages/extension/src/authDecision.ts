// packages/extension/src/authDecision.ts — vscode import 금지
import type { McpServerSpec } from '@mcp-lens/core';

export type AuthPromptAction =
  | { kind: 'skip' }
  | { kind: 'prompt'; targets: McpServerSpec[] };

/** auth-required(토큰 만료 포함)로 실패한 서버 중 authIgnore에 없는 서버만 골라 알림 대상으로 삼는다. */
export function decideAuthPrompt(args: {
  failedServers: McpServerSpec[];
  ignoreList: string[];
}): AuthPromptAction {
  const ignored = new Set(args.ignoreList);
  const targets = args.failedServers.filter((s) => !ignored.has(s.name));
  if (targets.length === 0) return { kind: 'skip' };
  return { kind: 'prompt', targets };
}
