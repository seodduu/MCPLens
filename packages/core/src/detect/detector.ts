import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ClientId } from '../types.js';
import { clientLogRoots } from '../paths.js';

export interface ClientStatus {
  client: ClientId; installed: boolean; activeWithinDays: number | null;
}

const ALL: ClientId[] = ['claude-code', 'codex', 'gemini-cli'];

export function detectClients(
  now = new Date(), rootsOverride?: Map<ClientId, string[]>,
): ClientStatus[] {
  return ALL.map((client) => {
    const roots = rootsOverride?.get(client) ?? clientLogRoots(client);
    const existing = roots.filter((r) => existsSync(r));
    if (existing.length === 0) return { client, installed: false, activeWithinDays: null };
    let latest = 0;
    for (const root of existing)
      for (const f of walkJsonl(root)) {
        try {
          latest = Math.max(latest, statSync(f).mtimeMs);
        } catch {
          // 파일이 사라졌거나 읽을 수 없는 경우 — 스킵
        }
      }
    return {
      client, installed: true,
      activeWithinDays: latest === 0 ? null
        : Math.floor((now.getTime() - latest) / 86_400_000),
    };
  });
}

function walkJsonl(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 읽을 수 없는 디렉터리 — 스킵하고 나머지 탐지는 계속
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(p, depth + 1));
    else if (/\.jsonl?$/.test(e.name)) out.push(p);
  }
  return out;
}
