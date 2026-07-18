import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, utimesSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LensStore } from '../../src/store/store.js';
import { LogWatcher } from '../../src/watch/watcher.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';

class TestClaudeAdapter extends ClaudeAdapter {
  constructor(private root: string) { super(); }
  override sessionRoots() { return [this.root]; }
  override matches(p: string) { return p.endsWith('.jsonl'); }
}

const FIXTURE = path.join(__dirname, '../../../../fixtures/claude/session-toolsearch.jsonl');

describe('LogWatcher.backfill', () => {
  it('루트의 모든 세션 파일을 파싱해 store에 적재한다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    copyFileSync(FIXTURE, path.join(dir, 's1.jsonl'));
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    const r = await w.backfill();
    expect(r.files).toBe(1);
    expect(store.callsSince('2000-01-01').length).toBeGreaterThan(0);
  });

  it('mtime이 같으면 두 번째 backfill은 스킵한다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const f = path.join(dir, 's1.jsonl');
    copyFileSync(FIXTURE, f);
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    await w.backfill();
    const r2 = await w.backfill();
    expect(r2.files).toBe(0); // 커서 mtime 일치 → 스킵
  });

  it('mtime이 바뀌면 다시 적재한다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const f = path.join(dir, 's1.jsonl');
    copyFileSync(FIXTURE, f);
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    await w.backfill();

    // mtime을 미래로 이동시켜 변경된 것처럼 만든다
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);

    const r2 = await w.backfill();
    expect(r2.files).toBe(1);
  });

  it('파싱 실패 라인이 있으면 parseErrors에 누적된다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const f = path.join(dir, 's1.jsonl');
    const content = readFileSync(FIXTURE, 'utf8');
    writeFileSync(f, content + '\n{not valid json\n');
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    const r = await w.backfill();
    expect(r.files).toBe(1);
    expect(r.parseErrors).toBeGreaterThan(0);
  });

  it('사라진/깨진 파일(dangling symlink)이 섞여 있어도 나머지는 정상 적재하고 던지지 않는다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    copyFileSync(FIXTURE, path.join(dir, 's1.jsonl'));
    // 존재하지 않는 대상을 가리키는 깨진 심볼릭 링크 — stat/readFile 시 ENOENT 유발
    symlinkSync(path.join(dir, 'does-not-exist.jsonl'), path.join(dir, 'broken.jsonl'));
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    const r = await w.backfill();
    expect(r.files).toBe(1); // 정상 파일만 카운트, 깨진 파일은 조용히 스킵
    expect(store.callsSince('2000-01-01').length).toBeGreaterThan(0);
  });
});
