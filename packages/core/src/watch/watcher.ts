import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { LogAdapter } from '../types.js';
import type { LensStore } from '../store/store.js';

export class LogWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(private store: LensStore, private adapters: LogAdapter[]) { super(); }

  async backfill(): Promise<{ files: number; parseErrors: number }> {
    let files = 0, parseErrors = 0;
    for (const adapter of this.adapters)
      for (const root of adapter.sessionRoots()) {
        if (!existsSync(root)) continue;
        for (const f of walk(root))
          if (adapter.matches(f)) {
            const result = this.ingestFile(adapter, f);
            if (result) {
              files++;
              parseErrors += result.parseErrors;
            }
          }
      }
    this.store.save();
    return { files, parseErrors };
  }

  start(): void {
    const roots = this.adapters.flatMap((a) => a.sessionRoots()).filter(existsSync);
    this.watcher = chokidar.watch(roots, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500 } });
    const onFile = (f: string) => {
      const adapter = this.adapters.find((a) => a.matches(f));
      if (adapter && this.ingestFile(adapter, f)) {
        this.store.save();
        this.emit('ingested', f);
      }
    };
    this.watcher.on('add', onFile).on('change', onFile);
  }

  async stop(): Promise<void> { await this.watcher?.close(); this.watcher = null; }

  /** 반환: 실제로 파싱·적재했는가 (mtime 커서 일치 시 null) — 적재 시 parseErrors 동반 반환 */
  private ingestFile(adapter: LogAdapter, filePath: string): { parseErrors: number } | null {
    let mtimeMs: number;
    let content: string;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
      const cursor = this.store.getCursor(filePath);
      if (cursor && cursor.mtimeMs === mtimeMs) return null;
      content = readFileSync(filePath, 'utf8');
    } catch {
      // 파일이 이벤트 발생 후 사라지거나 읽을 수 없는 경우 — 스킵
      return null;
    }
    // MVP: 전체 재파싱 (ingest가 세션 단위 멱등이므로 안전) — 커서는 스킵 판정용
    const result = adapter.parseFile(filePath, content);
    this.store.ingest(result);
    this.store.setCursor(filePath, Buffer.byteLength(content), mtimeMs);
    return { parseErrors: result.parseErrors };
  }
}

function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 읽을 수 없는 디렉터리 — 스킵하고 나머지 백필은 계속
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else out.push(p);
  }
  return out;
}
