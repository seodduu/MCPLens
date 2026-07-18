export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** ~/.claude.json의 mcpServers 필드를 파싱. 실패해도 throw 하지 않고 빈 배열 반환. */
export function readClaudeMcpConfig(jsonText: string): McpServerSpec[] {
  try {
    const cfg = JSON.parse(jsonText);
    const servers = cfg.mcpServers ?? {};
    return Object.entries(servers).flatMap(([name, s]: [string, any]) =>
      typeof s?.command === 'string'
        ? [{ name, command: s.command, args: s.args ?? [], env: s.env }]
        : [],
    );
  } catch {
    return [];
  }
}
