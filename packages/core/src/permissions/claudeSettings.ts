// packages/core/src/permissions/claudeSettings.ts (never import vscode)
// Pure module that reads and writes permissions.deny in ~/.claude/settings.json.
// Original-protection contract: never write on a parse failure. Before writing, back up to
// .mcplens.bak, then write to tmp and rename.
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonFile, writeJsonFile } from './fileUtils.js';

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Builds the deny rule string. Nothing ever parses (splits) it; rules are always built and compared. */
export function mcpDenyRule(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

interface ClaudeSettings {
  permissions?: { deny?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

function readSettings(settingsPath: string): ClaudeSettings {
  return (readJsonFile(settingsPath) ?? {}) as ClaudeSettings;
}

function denyList(settings: ClaudeSettings): string[] {
  const deny = settings.permissions?.deny;
  return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === 'string') : [];
}

export function readDeniedMcpTools(settingsPath: string): Set<string> {
  return new Set(denyList(readSettings(settingsPath)).filter((r) => r.startsWith('mcp__')));
}

export function denyMcpTool(settingsPath: string, server: string, tool: string): void {
  const settings = readSettings(settingsPath); // broken JSON throws here, leaving the file untouched
  const rule = mcpDenyRule(server, tool);
  const deny = denyList(settings);
  if (deny.includes(rule)) return;
  settings.permissions = { ...settings.permissions, deny: [...deny, rule] };
  writeJsonFile(settingsPath, settings);
}

export function allowMcpTool(settingsPath: string, server: string, tool: string): void {
  const settings = readSettings(settingsPath);
  const rule = mcpDenyRule(server, tool);
  const deny = denyList(settings);
  if (!deny.includes(rule)) return;
  settings.permissions = { ...settings.permissions, deny: deny.filter((r) => r !== rule) };
  writeJsonFile(settingsPath, settings);
}
