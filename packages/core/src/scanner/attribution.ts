// packages/core/src/scanner/attribution.ts
// 설정 소스 → 클라이언트 귀속. IO 없는 순수 매핑이라 단독 테스트한다.
// 설계: docs/superpowers/specs/2026-07-21-정의-클라이언트-귀속-design.md
import type { ClientId } from '../types.js';

/** 설정 소스 종류 → 클라이언트. claude-user·claude-project는 같은 클라이언트로 접힌다. */
export function clientForSourceKind(kind: string): ClientId | null {
  switch (kind) {
    case 'claude-user':
    case 'claude-project':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini-cli';
    default:
      return null;
  }
}

export interface SourceRead {
  kind: string;
  /** 이 소스에서 발견한 서버 이름들 */
  servers: string[];
  /** 'missing'(파일 없음)은 정상 — 서버 0개로 취급한다. 'error'만 관찰 실패다. */
  failed: 'none' | 'missing' | 'error';
}

/**
 * 소스별 읽기 결과 → (서버 → 클라이언트 집합) 귀속과, 매핑을 통째로 교체해도 되는
 * 클라이언트 집합.
 *
 * 교체 가능 판정: 한 클라이언트의 소스 중 'error'가 하나라도 있으면 제외한다.
 * 읽기 실패를 "서버 없음"으로 해석하면 그 클라이언트의 정의가 화면에서 통째로 사라진다.
 * 파일 부재는 정상이므로(프로젝트별 .mcp.json은 대부분 없다) 교체 대상에 남긴다.
 */
export function attributeServers(reads: SourceRead[]): {
  attribution: Map<string, Set<ClientId>>;
  replaceable: Set<ClientId>;
} {
  const attribution = new Map<string, Set<ClientId>>();
  const seen = new Set<ClientId>();
  const broken = new Set<ClientId>();

  for (const r of reads) {
    const client = clientForSourceKind(r.kind);
    if (client === null) continue;
    seen.add(client);
    if (r.failed === 'error') broken.add(client);
    for (const name of r.servers) {
      let set = attribution.get(name);
      if (set === undefined) { set = new Set(); attribution.set(name, set); }
      set.add(client);
    }
  }

  const replaceable = new Set<ClientId>();
  for (const c of seen) if (!broken.has(c)) replaceable.add(c);
  return { attribution, replaceable };
}
