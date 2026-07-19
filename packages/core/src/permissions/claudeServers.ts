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
import { readJsonFile, writeJsonFile } from './fileUtils.js';

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

/** 읽기 관대 버전: 깨진 파일은 null로 취급. */
function readLenient(filePath: string): unknown | null {
  try { return readJsonFile(filePath); } catch { return null; }
}

function serverNames(obj: unknown): string[] {
  const m = (obj as { mcpServers?: unknown } | null)?.mcpServers;
  return m && typeof m === 'object' ? Object.keys(m) : [];
}

function disabledMcpjson(settings: unknown): string[] {
  const list = (settings as { disabledMcpjsonServers?: unknown } | null)?.disabledMcpjsonServers;
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
}

export function listManagedServers(paths: ClaudeConfigPaths): ManagedServer[] {
  const disabledJson = new Set(disabledMcpjson(readLenient(paths.settingsPath)));
  const stash = (readLenient(paths.stashPath) ?? {}) as Record<string, StashedServer>;

  const origins = new Map<string, Set<'user' | 'project'>>();
  const add = (name: string, origin: 'user' | 'project') => {
    if (!origins.has(name)) origins.set(name, new Set());
    origins.get(name)!.add(origin);
  };

  const cj = readLenient(paths.claudeJsonPath) as
    { mcpServers?: unknown; projects?: Record<string, unknown> } | null;
  for (const name of serverNames(cj)) add(name, 'user');
  for (const proj of Object.values(cj?.projects ?? {})) {
    for (const name of serverNames(proj)) add(name, 'user');
  }
  for (const p of paths.mcpJsonPaths) {
    for (const name of serverNames(readLenient(p))) add(name, 'project');
  }
  for (const name of Object.keys(stash)) add(name, 'user'); // 스태시는 항상 유저 전역 출신

  return [...origins.entries()].map(([name, o]) => ({
    name,
    enabled: !disabledJson.has(name) && !(name in stash),
    origins: [...o],
  }));
}

export function disableServer(paths: ClaudeConfigPaths, name: string): void {
  // 이 호출에서 쓸 수도 있는 모든 파일을 먼저 엄격하게 읽는다 (쓰기 전 전부 읽기 —
  // 파싱 실패는 어떤 파일도 쓰기 전에 throw되어야 strict-write 보장이 성립한다).
  const cj = readJsonFile(paths.claudeJsonPath) as
    { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> } | null;

  const inMcpJson = paths.mcpJsonPaths.some((p) => serverNames(readLenient(p)).includes(name));
  const settings = inMcpJson
    ? ((readJsonFile(paths.settingsPath) ?? {}) as Record<string, unknown>)
    : null;
  const stash = (readJsonFile(paths.stashPath) ?? {}) as Record<string, StashedServer>;

  // 1) 유저 전역: ~/.claude.json → 스태시 이동.
  let origin: StashOrigin | null = null;
  let spec: unknown;
  if (cj?.mcpServers && name in cj.mcpServers) {
    origin = { kind: 'user' };
    spec = cj.mcpServers[name];
    delete cj.mcpServers[name];
  } else if (cj?.projects) {
    for (const [projectPath, proj] of Object.entries(cj.projects)) {
      if (proj?.mcpServers && name in proj.mcpServers) {
        origin = { kind: 'user-project', projectPath };
        spec = proj.mcpServers[name];
        delete proj.mcpServers[name];
        break;
      }
    }
  }
  if (origin && cj) {
    // 스태시 항목 쓰기와 claude.json 정리는 별개 관심사: 스태시는 없을 때만 채우고
    // (멱등성), claude.json은 서버가 여전히 남아있을 때마다 정리한다
    // (스태시-먼저 순서로 인한 크래시/EPERM 중간 상태에서도 재시도로 복구 가능해야 함).
    if (!(name in stash)) {
      stash[name] = { origin, spec, disabledAt: new Date().toISOString() };
      writeJsonFile(paths.stashPath, stash);      // 스펙 유실 방지: 스태시 먼저
    }
    writeJsonFile(paths.claudeJsonPath, cj);
  }

  // 2) 프로젝트 .mcp.json: settings의 disabledMcpjsonServers에 추가 (.mcp.json은 읽기 전용).
  if (inMcpJson && settings) {
    const list = disabledMcpjson(settings);
    if (!list.includes(name)) {
      settings.disabledMcpjsonServers = [...list, name];
      writeJsonFile(paths.settingsPath, settings);
    }
  }
}

export function enableServer(paths: ClaudeConfigPaths, name: string): void {
  // 이 호출에서 쓸 수도 있는 모든 파일을 먼저 엄격하게 읽는다 (쓰기 전 전부 읽기 —
  // 파싱 실패는 어떤 파일도 쓰기 전에 throw되어야 strict-write 보장이 성립한다).
  const stash = (readJsonFile(paths.stashPath) ?? {}) as Record<string, StashedServer>;
  const entry = stash[name];
  const cj = entry
    ? ((readJsonFile(paths.claudeJsonPath) ?? {}) as
        { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> })
    : null;
  const settings = readJsonFile(paths.settingsPath) as Record<string, unknown> | null;

  // 1) 스태시 → ~/.claude.json 원위치 복원 (복원 먼저, 스태시 제거는 나중 — 스펙 유실 방지).
  if (entry && cj) {
    if (entry.origin.kind === 'user') {
      // 사용자가 스태시 이후 같은 이름으로 직접 재등록했다면 그 정의를 보존한다 —
      // 스태시된(오래된) 스펙으로 덮어쓰지 않는다.
      if (!cj.mcpServers || !(name in cj.mcpServers)) {
        cj.mcpServers = { ...cj.mcpServers, [name]: entry.spec };
        writeJsonFile(paths.claudeJsonPath, cj);
      }
    } else {
      const pp = entry.origin.projectPath;
      const existing = cj.projects?.[pp]?.mcpServers;
      if (!existing || !(name in existing)) {
        cj.projects = { ...cj.projects };
        cj.projects[pp] = { ...cj.projects[pp], mcpServers: { ...cj.projects[pp]?.mcpServers, [name]: entry.spec } };
        writeJsonFile(paths.claudeJsonPath, cj);
      }
    }
    delete stash[name];
    writeJsonFile(paths.stashPath, stash);
  }

  // 2) disabledMcpjsonServers에서 제거.
  const list = disabledMcpjson(settings);
  if (settings && list.includes(name)) {
    settings.disabledMcpjsonServers = list.filter((n) => n !== name);
    writeJsonFile(paths.settingsPath, settings);
  }
}
