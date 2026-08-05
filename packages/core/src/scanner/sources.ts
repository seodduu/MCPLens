import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readClaudeMcpConfig, collectServerSpecs, type CollectResult, type McpServerSpec } from './configs.js';
import { attributeServers, type SourceRead } from './attribution.js';
import { clientForSourceKind } from './attribution.js';
import { computeEndpointHash, computeSourcePathHash } from './serverIdentity.js';
import type { ClientId, ConfigSourceKind, ServerIdentity } from '../types.js';
import { specTransport } from './configs.js';

/** Config source kind: 'claude-user' | 'claude-project' | 'codex' | 'gemini' */
export interface ConfigSource {
  kind: string;
  /** Absolute path to watch (may not exist). */
  filePath: string;
}

/** Extracts project paths from the projects key of ~/.claude.json text (empty array on a parse failure). */
function claudeProjectPathsFromText(text: string): string[] {
  try {
    const cfg = JSON.parse(text);
    const projects = cfg?.projects;
    if (!projects || typeof projects !== 'object') return [];
    return Object.keys(projects);
  } catch {
    return [];
  }
}

/** Reads ~/.claude.json and extracts project paths from its projects key (empty array on a read failure). */
function claudeProjectPaths(): string[] {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    const text = fs.readFileSync(claudeJsonPath, 'utf-8');
    return claudeProjectPathsFromText(text);
  } catch {
    return [];
  }
}

export interface ConfigSourcesOptions {
  /**
   * Injects the contents of ~/.claude.json to derive the claude-project paths.
   * When provided, no real file is read (so unit tests never touch real-device files).
   * When omitted, ~/.claude.json is readFileSync'd as before (ignored when missing).
   */
  claudeUserJson?: string;
}

/** Config files to watch and collect on this machine (paths are returned whether or not they exist). */
export function configSources(opts?: ConfigSourcesOptions): ConfigSource[] {
  const h = os.homedir();
  const sources: ConfigSource[] = [
    { kind: 'claude-user', filePath: path.join(h, '.claude.json') },
  ];
  const projectPaths =
    opts?.claudeUserJson !== undefined
      ? claudeProjectPathsFromText(opts.claudeUserJson)
      : claudeProjectPaths();
  for (const projectPath of projectPaths) {
    sources.push({ kind: 'claude-project', filePath: path.join(projectPath, '.mcp.json') });
  }
  sources.push({ kind: 'codex', filePath: path.join(h, '.codex', 'config.toml') });
  sources.push({ kind: 'gemini', filePath: path.join(h, '.gemini', 'settings.json') });
  return sources;
}

/** Parses the mcp_servers table of codex `~/.codex/config.toml`. Servers with enabled=false are reported as skipped. */
function collectCodex(text: string): CollectResult {
  let toml: any;
  try {
    toml = parseToml(text);
  } catch {
    return { specs: [], skipped: [] };
  }

  const mcpServers = toml?.mcp_servers;
  if (!mcpServers || typeof mcpServers !== 'object') return { specs: [], skipped: [] };

  const specs: McpServerSpec[] = [];
  const skipped: string[] = [];

  for (const [name, s] of Object.entries(mcpServers) as [string, any][]) {
    if (s?.enabled === false) {
      skipped.push(name);
      continue;
    }
    if (typeof s?.command === 'string') {
      specs.push({ name, command: s.command, args: s.args ?? [], env: s.env });
    }
    // Entries with neither a command nor enabled=false (transport undeterminable) are ignored on purpose.
    // Unlike the unknown handling in collectServerSpecs, codex has no http url field, so the skip reason differs and it is dropped with no contract.
  }

  return { specs, skipped };
}

/** File content string -> specs. A parse failure yields an empty result (never throws). */
export function collectFromSource(kind: string, text: string): CollectResult {
  switch (kind) {
    case 'claude-user':
      return collectServerSpecs(text);
    case 'claude-project':
    case 'gemini':
      return { specs: readClaudeMcpConfig(text), skipped: [] };
    case 'codex':
      return collectCodex(text);
    default:
      return { specs: [], skipped: [] };
  }
}

/** Merges the given sources using the given file reader. The testable core of collectAllSpecs. */
export function collectFromSources(
  sources: ConfigSource[],
  readFile: (filePath: string) => string,
): CollectResult & {
  sources: ConfigSource[];
  attribution: Map<string, Set<ClientId>>;
  replaceable: Set<ClientId>;
  identities: ServerIdentity[];
} {
  const priority: Record<string, number> = {
    'claude-user': 0,
    'claude-project': 1,
    codex: 2,
    gemini: 3,
  };
  const ordered = [...sources].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99));

  const byName = new Map<string, McpServerSpec>();
  const skippedSet = new Set<string>();
  const reads: SourceRead[] = [];
  const identities: ServerIdentity[] = [];
  const observedAt = new Date().toISOString();

  for (const source of ordered) {
    let text: string;
    try {
      text = readFile(source.filePath);
    } catch (err) {
      // A missing file is normal (most projects have no .mcp.json), so it is distinguished from a failed observation.
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      reads.push({ kind: source.kind, servers: [], failed: missing ? 'missing' : 'error' });
      continue;
    }
    const { specs, skipped } = collectFromSource(source.kind, text);
    reads.push({ kind: source.kind, servers: specs.map((s) => s.name), failed: 'none' });
    const client = clientForSourceKind(source.kind);
    if (client !== null) {
      for (const spec of specs) {
        const transport = specTransport(spec);
        if (transport === 'unknown') continue;
        identities.push({
          client,
          serverName: spec.name,
          sourceKind: source.kind as ConfigSourceKind,
          sourcePathHash: computeSourcePathHash(source.filePath),
          transport,
          endpointHash: computeEndpointHash(spec),
          conflictState: 'clear',
          observedAt,
        });
      }
    }
    for (const spec of specs) {
      if (!byName.has(spec.name)) byName.set(spec.name, spec);
    }
    for (const name of skipped) skippedSet.add(name);
  }

  const { attribution, replaceable } = attributeServers(reads);
  markEndpointConflicts(identities);
  return { specs: [...byName.values()], skipped: [...skippedSet], sources,
    attribution, replaceable, identities };
}

/** Reads and merges every source file (read-only, missing files ignored). Priority: claude-user > claude-project > codex > gemini (first one wins on a name clash). */
export function collectAllSpecs(): CollectResult & {
  sources: ConfigSource[];
  attribution: Map<string, Set<ClientId>>;
  replaceable: Set<ClientId>;
  identities: ServerIdentity[];
} {
  return collectFromSources(configSources(), (p) => fs.readFileSync(p, 'utf-8'));
}

function markEndpointConflicts(identities: ServerIdentity[]): void {
  const hashesByName = new Map<string, Set<string>>();
  for (const identity of identities) {
    let hashes = hashesByName.get(identity.serverName);
    if (hashes === undefined) {
      hashes = new Set();
      hashesByName.set(identity.serverName, hashes);
    }
    hashes.add(identity.endpointHash);
  }
  for (const identity of identities) {
    if ((hashesByName.get(identity.serverName)?.size ?? 0) > 1) {
      identity.conflictState = 'conflict';
    }
  }
}
