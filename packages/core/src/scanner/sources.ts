import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readClaudeMcpConfig, collectServerSpecs, type CollectResult, type McpServerSpec } from './configs.js';

/** 설정 소스 종류: 'claude-user' | 'claude-project' | 'codex' | 'gemini' */
export interface ConfigSource {
  kind: string;
  /** 감시 대상 절대경로 (존재하지 않을 수 있음) */
  filePath: string;
}

/** ~/.claude.json 의 projects 키에서 프로젝트 경로 목록을 뽑는다 (읽기 실패 시 빈 배열). */
function claudeProjectPaths(): string[] {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    const text = fs.readFileSync(claudeJsonPath, 'utf-8');
    const cfg = JSON.parse(text);
    const projects = cfg?.projects;
    if (!projects || typeof projects !== 'object') return [];
    return Object.keys(projects);
  } catch {
    return [];
  }
}

/** 이 머신에서 감시·수집할 설정 파일 목록 (존재 여부와 무관하게 경로 반환). */
export function configSources(): ConfigSource[] {
  const h = os.homedir();
  const sources: ConfigSource[] = [
    { kind: 'claude-user', filePath: path.join(h, '.claude.json') },
  ];
  for (const projectPath of claudeProjectPaths()) {
    sources.push({ kind: 'claude-project', filePath: path.join(projectPath, '.mcp.json') });
  }
  sources.push({ kind: 'codex', filePath: path.join(h, '.codex', 'config.toml') });
  sources.push({ kind: 'gemini', filePath: path.join(h, '.gemini', 'settings.json') });
  return sources;
}

/** codex `~/.codex/config.toml` 의 mcp_servers 테이블을 파싱한다. enabled=false 인 서버는 skipped 처리. */
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
  }

  return { specs, skipped };
}

/** 파일 내용 문자열 → 스펙. 파싱 실패는 빈 결과 (throw 금지). */
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

/** 모든 소스 파일을 읽어 병합 (읽기 전용, 없는 파일은 무시). 우선순위: claude-user > claude-project > codex > gemini (이름 충돌 시 먼저 온 것). */
export function collectAllSpecs(): CollectResult & { sources: ConfigSource[] } {
  const sources = configSources();
  const priority: Record<string, number> = {
    'claude-user': 0,
    'claude-project': 1,
    codex: 2,
    gemini: 3,
  };
  const ordered = [...sources].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99));

  const byName = new Map<string, McpServerSpec>();
  const skippedSet = new Set<string>();

  for (const source of ordered) {
    let text: string;
    try {
      text = fs.readFileSync(source.filePath, 'utf-8');
    } catch {
      continue;
    }
    const { specs, skipped } = collectFromSource(source.kind, text);
    for (const spec of specs) {
      if (!byName.has(spec.name)) byName.set(spec.name, spec);
    }
    for (const name of skipped) skippedSet.add(name);
  }

  return { specs: [...byName.values()], skipped: [...skippedSet], sources };
}
