// packages/core/src/scanner/attribution.ts
// Config source -> client attribution. Pure mapping with no IO, so it is tested on its own.
// Design: docs/superpowers/specs/2026-07-21-정의-클라이언트-귀속-design.md
import type { ClientId } from '../types.js';

/** Config source kind -> client. claude-user and claude-project fold into the same client. */
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
  /** Server names discovered in this source. */
  servers: string[];
  /** 'missing' (no file) is normal and counts as zero servers. Only 'error' is a failed observation. */
  failed: 'none' | 'missing' | 'error';
}

/**
 * Per-source read results -> (server -> set of clients) attribution, plus the set of clients whose
 * mapping may be replaced wholesale.
 *
 * Replaceability: a client is excluded if any of its sources is in 'error'. Reading a failure as
 * "no servers" would erase that client's definitions from the screen entirely.
 * A missing file is normal (most projects have no .mcp.json), so it stays replaceable.
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
