// packages/core/src/permissions/claudeServers.ts (never import vscode)
// Per-server disable/restore for Claude Code MCP servers.
// .mcp.json servers: toggled through settings.json disabledMcpjsonServers (the official switch).
// ~/.claude.json servers: the spec is moved to and from a stash file (lossless).
// Reads are lenient (broken files are skipped); writes are strict (a parse failure throws and
// changes nothing).
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
  mcpJsonPaths: string[]; // detected project .mcp.json paths
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
  /** The entry exactly as it was in ~/.claude.json (moved wholesale without interpretation, so restore is lossless). */
  spec: unknown;
  disabledAt: string;
}

export interface ManagedServer {
  name: string;
  /** false means it sits in disabledMcpjsonServers or in the stash. */
  enabled: boolean;
  /** 'user' = ~/.claude.json (both top-level and projects), 'project' = .mcp.json */
  origins: ('user' | 'project')[];
}

/** Lenient read: a broken file is treated as null. */
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
  for (const name of Object.keys(stash)) add(name, 'user'); // stashed entries always come from the user-global file

  return [...origins.entries()].map(([name, o]) => ({
    name,
    enabled: !disabledJson.has(name) && !(name in stash),
    origins: [...o],
  }));
}

export function disableServer(paths: ClaudeConfigPaths, name: string): void {
  // Strictly read every file this call might write, before writing anything: a parse failure must
  // throw before any file is touched for the strict-write guarantee to hold.
  const cj = readJsonFile(paths.claudeJsonPath) as
    { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> } | null;

  const inMcpJson = paths.mcpJsonPaths.some((p) => serverNames(readLenient(p)).includes(name));
  const settings = inMcpJson
    ? ((readJsonFile(paths.settingsPath) ?? {}) as Record<string, unknown>)
    : null;
  const stash = (readJsonFile(paths.stashPath) ?? {}) as Record<string, StashedServer>;

  // 1) User-global: move the ~/.claude.json entry into the stash.
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
    // The stash must always reflect "the spec we just actually removed from claude.json".
    // The user may have re-registered the same name by hand with a different spec after an
    // earlier disable (origin is then found again and we land in this branch), so even when the
    // stash already has an entry we must not skip with that stale spec; we overwrite it with the
    // spec just read. Only then do the spec erased from claude.json and the spec kept in the
    // stash always match (lossless).
    // disabledAt alone preserves the first disable time to keep this idempotent.
    // (If the server is absent from claude.json, origin is never found and we never enter this
    // branch, so a genuine double disable stays a complete no-op that writes nothing.)
    const prior = stash[name];
    stash[name] = { origin, spec, disabledAt: prior?.disabledAt ?? new Date().toISOString() };
    writeJsonFile(paths.stashPath, stash);      // stash first, so the spec cannot be lost
    writeJsonFile(paths.claudeJsonPath, cj);
  }

  // 2) Project .mcp.json: add to disabledMcpjsonServers in settings (.mcp.json stays read-only).
  if (inMcpJson && settings) {
    const list = disabledMcpjson(settings);
    if (!list.includes(name)) {
      settings.disabledMcpjsonServers = [...list, name];
      writeJsonFile(paths.settingsPath, settings);
    }
  }
}

export function enableServer(paths: ClaudeConfigPaths, name: string): void {
  // Strictly read every file this call might write, before writing anything: a parse failure must
  // throw before any file is touched for the strict-write guarantee to hold.
  const stash = (readJsonFile(paths.stashPath) ?? {}) as Record<string, StashedServer>;
  const entry = stash[name];
  const cj = entry
    ? ((readJsonFile(paths.claudeJsonPath) ?? {}) as
        { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> })
    : null;
  // Unlike disableServer, the settings.json read here cannot be gated on a condition:
  // disableServer can decide up front from inMcpJson whether it is needed, but enableServer
  // cannot know whether the name is in disabledMcpjsonServers without reading settings.json.
  // So it always reads strictly, which means a broken settings.json makes enableServer throw even
  // for a name it would never have written (intended behaviour).
  const settings = readJsonFile(paths.settingsPath) as Record<string, unknown> | null;

  // 1) Restore stash -> ~/.claude.json in place (restore first, remove from the stash after, so the spec cannot be lost).
  if (entry && cj) {
    if (entry.origin.kind === 'user') {
      // If the user re-registered the same name by hand after the stash, keep their definition;
      // never overwrite it with the stale stashed spec.
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

  // 2) Remove from disabledMcpjsonServers.
  const list = disabledMcpjson(settings);
  if (settings && list.includes(name)) {
    settings.disabledMcpjsonServers = list.filter((n) => n !== name);
    writeJsonFile(paths.settingsPath, settings);
  }
}
