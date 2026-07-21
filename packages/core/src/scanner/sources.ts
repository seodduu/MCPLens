import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readClaudeMcpConfig, collectServerSpecs, type CollectResult, type McpServerSpec } from './configs.js';
import { attributeServers, type SourceRead } from './attribution.js';
import type { ClientId } from '../types.js';

/** 설정 소스 종류: 'claude-user' | 'claude-project' | 'codex' | 'gemini' */
export interface ConfigSource {
  kind: string;
  /** 감시 대상 절대경로 (존재하지 않을 수 있음) */
  filePath: string;
}

/** ~/.claude.json 텍스트의 projects 키에서 프로젝트 경로 목록을 뽑는다 (파싱 실패 시 빈 배열). */
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

/** ~/.claude.json 을 읽어 projects 키에서 프로젝트 경로 목록을 뽑는다 (읽기 실패 시 빈 배열). */
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
   * ~/.claude.json 내용을 주입해 claude-project 경로를 유도한다.
   * 제공되면 실제 파일을 읽지 않는다 (유닛테스트에서 실기기 파일 접근을 피하기 위함).
   * 생략 시 기존 동작대로 ~/.claude.json 을 readFileSync 한다 (없으면 무시).
   */
  claudeUserJson?: string;
}

/** 이 머신에서 감시·수집할 설정 파일 목록 (존재 여부와 무관하게 경로 반환). */
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
    // command 도 없고 enabled=false 도 아닌 항목(전송 판별 불가)은 의도적으로 무시한다.
    // collectServerSpecs 의 unknown 처리와 달리 codex 는 http url 필드가 없어 skipped 사유가 다르므로 별도 계약 없이 drop.
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

/** 소스 목록과 파일 읽기 함수를 받아 병합한다. collectAllSpecs의 테스트 가능한 알맹이. */
export function collectFromSources(
  sources: ConfigSource[],
  readFile: (filePath: string) => string,
): CollectResult & {
  sources: ConfigSource[];
  attribution: Map<string, Set<ClientId>>;
  replaceable: Set<ClientId>;
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

  for (const source of ordered) {
    let text: string;
    try {
      text = readFile(source.filePath);
    } catch (err) {
      // 파일 부재는 정상(프로젝트별 .mcp.json은 대부분 없다) — 관찰 실패와 구분한다.
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      reads.push({ kind: source.kind, servers: [], failed: missing ? 'missing' : 'error' });
      continue;
    }
    const { specs, skipped } = collectFromSource(source.kind, text);
    reads.push({ kind: source.kind, servers: specs.map((s) => s.name), failed: 'none' });
    for (const spec of specs) {
      if (!byName.has(spec.name)) byName.set(spec.name, spec);
    }
    for (const name of skipped) skippedSet.add(name);
  }

  const { attribution, replaceable } = attributeServers(reads);
  return { specs: [...byName.values()], skipped: [...skippedSet], sources,
    attribution, replaceable };
}

/** 모든 소스 파일을 읽어 병합 (읽기 전용, 없는 파일은 무시). 우선순위: claude-user > claude-project > codex > gemini (이름 충돌 시 먼저 온 것). */
export function collectAllSpecs(): CollectResult & {
  sources: ConfigSource[];
  attribution: Map<string, Set<ClientId>>;
  replaceable: Set<ClientId>;
} {
  return collectFromSources(configSources(), (p) => fs.readFileSync(p, 'utf-8'));
}
