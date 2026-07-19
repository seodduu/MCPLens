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

export interface CollectResult {
  /** stdio 서버 스펙 (top-level + projects, 서버명으로 dedupe). */
  specs: McpServerSpec[];
  /** command 필드가 없어 건너뛴 (stdio 아님) 서버명 목록. */
  skipped: string[];
}

/**
 * ~/.claude.json 텍스트에서 stdio MCP 서버 스펙을 수집한다.
 * top-level mcpServers 와 projects.<path>.mcpServers 를 병합하며 서버명으로 중복 제거한다.
 * core의 readClaudeMcpConfig(top-level만 파싱)를 프로젝트 단위로 재사용한다.
 * 파싱 실패 시 throw 하지 않고 빈 결과를 반환한다.
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
    // stdio 스펙 추출 (readClaudeMcpConfig 재사용)
    const stdio = readClaudeMcpConfig(JSON.stringify({ mcpServers: servers }));
    const stdioNames = new Set(stdio.map((s) => s.name));
    for (const s of stdio) if (!byName.has(s.name)) byName.set(s.name, s);
    // command 없는 (non-stdio, 예: {type:"http"}) 서버는 skip 통지
    for (const name of Object.keys(servers)) {
      if (!stdioNames.has(name) && !byName.has(name)) skipped.add(name);
    }
  };

  mergeSection(cfg.mcpServers);
  const projects = cfg.projects;
  if (projects && typeof projects === 'object') {
    for (const proj of Object.values(projects) as any[]) {
      mergeSection(proj?.mcpServers);
    }
  }

  // 다른 섹션에서 stdio 로 잡힌 서버는 skip 목록에서 제외
  return { specs: [...byName.values()], skipped: [...skipped].filter((n) => !byName.has(n)) };
}
