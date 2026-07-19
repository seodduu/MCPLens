// packages/core/src/permissions/claudeSettings.ts — vscode import 금지
// ~/.claude/settings.json 의 permissions.deny 를 읽고 쓰는 순수 모듈.
// 원본 보호 계약: 파싱 실패 시 절대 쓰지 않는다. 쓰기 전 .mcplens.bak 백업 + tmp/rename.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** deny 규칙 문자열 조립. 파싱(쪼개기)은 어디서도 하지 않는다 — 항상 조립해서 대조. */
export function mcpDenyRule(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

interface ClaudeSettings {
  permissions?: { deny?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
}

function denyList(settings: ClaudeSettings): string[] {
  const deny = settings.permissions?.deny;
  return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === 'string') : [];
}

export function readDeniedMcpTools(settingsPath: string): Set<string> {
  return new Set(denyList(readSettings(settingsPath)).filter((r) => r.startsWith('mcp__')));
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.mcplens.bak`);
  const tmp = `${settingsPath}.mcplens.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, settingsPath);
}

export function denyMcpTool(settingsPath: string, server: string, tool: string): void {
  const settings = readSettings(settingsPath); // 깨진 JSON이면 여기서 throw — 파일 미변경
  const rule = mcpDenyRule(server, tool);
  const deny = denyList(settings);
  if (deny.includes(rule)) return;
  settings.permissions = { ...settings.permissions, deny: [...deny, rule] };
  writeSettings(settingsPath, settings);
}

export function allowMcpTool(settingsPath: string, server: string, tool: string): void {
  const settings = readSettings(settingsPath);
  const rule = mcpDenyRule(server, tool);
  const deny = denyList(settings);
  if (!deny.includes(rule)) return;
  settings.permissions = { ...settings.permissions, deny: deny.filter((r) => r !== rule) };
  writeSettings(settingsPath, settings);
}
