// packages/core/src/permissions/claudeSettings.ts — vscode import 금지
// ~/.claude/settings.json 의 permissions.deny 를 읽고 쓰는 순수 모듈.
// 원본 보호 계약: 파싱 실패 시 절대 쓰지 않는다. 쓰기 전 .mcplens.bak 백업 + tmp/rename.
import * as os from 'node:os';
import * as path from 'node:path';

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** deny 규칙 문자열 조립. 파싱(쪼개기)은 어디서도 하지 않는다 — 항상 조립해서 대조. */
export function mcpDenyRule(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function readDeniedMcpTools(settingsPath: string): Set<string> {
  void settingsPath;
  return new Set(); // Task 1에서 구현
}

export function denyMcpTool(settingsPath: string, server: string, tool: string): void {
  void settingsPath; void server; void tool;
  throw new Error('not implemented'); // Task 1에서 구현
}

export function allowMcpTool(settingsPath: string, server: string, tool: string): void {
  void settingsPath; void server; void tool;
  throw new Error('not implemented'); // Task 1에서 구현
}
