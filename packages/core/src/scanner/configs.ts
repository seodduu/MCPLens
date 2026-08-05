export interface McpServerSpec {
  name: string;
  /** stdio server: the command to run. http server: undefined. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http server: the URL to connect to. stdio server: undefined. */
  url?: string;
  /** http server: custom headers to send (a PAT, say: Authorization: Bearer ...). */
  headers?: Record<string, string>;
}

/** 'stdio' with a command, 'http' with a url and no command, otherwise 'unknown'. */
export function specTransport(s: McpServerSpec): 'stdio' | 'http' | 'unknown' {
  if (s.command) return 'stdio';
  if (s.url) return 'http';
  return 'unknown';
}

/** Parses the mcpServers field of ~/.claude.json. Never throws; returns an empty array on failure. */
export function readClaudeMcpConfig(jsonText: string): McpServerSpec[] {
  try {
    const cfg = JSON.parse(jsonText);
    const servers = cfg.mcpServers ?? {};
    return Object.entries(servers).flatMap(([name, s]: [string, any]) => {
      if (typeof s?.command === 'string') {
        return [{ name, command: s.command, args: s.args ?? [], env: s.env }];
      }
      if (typeof s?.url === 'string') {
        const headers = s.headers && typeof s.headers === 'object' ? s.headers : undefined;
        return [{ name, command: undefined, args: undefined, env: undefined, url: s.url, headers }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export interface CollectResult {
  /** stdio/http server specs (top-level + projects, deduped by server name). */
  specs: McpServerSpec[];
  /** Names of servers skipped because the transport could not be determined (unknown). */
  skipped: string[];
}

/**
 * Collects MCP server specs (stdio and http) from the text of ~/.claude.json.
 * Merges top-level mcpServers with projects.<path>.mcpServers, deduping by server name.
 * Reuses core's readClaudeMcpConfig (which parses only the top level) per project.
 * Returns an empty result instead of throwing on a parse failure.
 */
export function collectServerSpecs(jsonText: string): CollectResult {
  let cfg: any;
  try {
    cfg = JSON.parse(jsonText);
  } catch {
    return { specs: [], skipped: [] };
  }

  const byName = new Map<string, McpServerSpec>();
  const skipped = new Set<string>();

  const mergeSection = (servers: Record<string, any> | undefined | null): void => {
    if (!servers || typeof servers !== 'object') return;
    // Extract stdio/http specs (reusing readClaudeMcpConfig)
    const parsed = readClaudeMcpConfig(JSON.stringify({ mcpServers: servers }));
    const parsedNames = new Set(parsed.map((s) => s.name));
    for (const s of parsed) if (!byName.has(s.name)) byName.set(s.name, s);
    // Report servers whose transport cannot be determined (unknown, e.g. {} or {type:"http"} without url) as skipped
    for (const name of Object.keys(servers)) {
      if (!parsedNames.has(name) && !byName.has(name)) skipped.add(name);
    }
  };

  mergeSection(cfg.mcpServers);
  const projects = cfg.projects;
  if (projects && typeof projects === 'object') {
    for (const proj of Object.values(projects) as any[]) {
      mergeSection(proj?.mcpServers);
    }
  }

  // A server found as stdio in another section drops out of the skipped list
  return { specs: [...byName.values()], skipped: [...skipped].filter((n) => !byName.has(n)) };
}
