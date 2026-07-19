// packages/core/src/permissions/claudeServers.ts — vscode import 금지
// Claude Code MCP 서버 단위 비활성/복원.
// .mcp.json 서버 → settings.json disabledMcpjsonServers 토글 (공식 스위치).
// ~/.claude.json 서버 → 스태시 파일로 스펙 이동/복원 (무손실).
// 읽기는 관대(깨진 파일 건너뜀), 쓰기는 엄격(파싱 실패 시 throw + 미변경).
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeSettingsPath } from './claudeSettings.js';
import { configSources } from '../scanner/sources.js';
import { lensHome } from '../paths.js';

export interface ClaudeConfigPaths {
  settingsPath: string;   // ~/.claude/settings.json
  claudeJsonPath: string; // ~/.claude.json
  stashPath: string;      // ~/.mcplens/disabled-servers.json
  mcpJsonPaths: string[]; // 감지된 프로젝트 .mcp.json 경로들
}

export function defaultClaudeConfigPaths(): ClaudeConfigPaths {
  return {
    settingsPath: claudeSettingsPath(),
    claudeJsonPath: path.join(os.homedir(), '.claude.json'),
    stashPath: path.join(lensHome(), 'disabled-servers.json'),
    mcpJsonPaths: configSources()
      .filter((s) => s.kind === 'claude-project')
      .map((s) => s.filePath),
  };
}

export type StashOrigin =
  | { kind: 'user' }                                   // ~/.claude.json top-level mcpServers
  | { kind: 'user-project'; projectPath: string };     // ~/.claude.json projects.<path>.mcpServers

export interface StashedServer {
  origin: StashOrigin;
  /** ~/.claude.json에 있던 항목 원형 그대로 (해석 없이 통째 이동 — 복원 무손실) */
  spec: unknown;
  disabledAt: string;
}

export interface ManagedServer {
  name: string;
  /** false = disabledMcpjsonServers 또는 스태시에 있음 */
  enabled: boolean;
  /** 'user' = ~/.claude.json (top-level·projects 모두), 'project' = .mcp.json */
  origins: ('user' | 'project')[];
}

export function listManagedServers(paths: ClaudeConfigPaths): ManagedServer[] {
  void paths;
  return []; // Task 1에서 구현
}

export function disableServer(paths: ClaudeConfigPaths, name: string): void {
  void paths; void name;
  throw new Error('not implemented'); // Task 1에서 구현
}

export function enableServer(paths: ClaudeConfigPaths, name: string): void {
  void paths; void name;
  throw new Error('not implemented'); // Task 1에서 구현
}
