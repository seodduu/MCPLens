import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, copyFileSync, mkdirSync, utimesSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LensStore } from '../../src/store/store.js';
import { LogWatcher } from '../../src/watch/watcher.js';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.js';

class TestClaudeAdapter extends ClaudeAdapter {
  parseCount = 0;
  constructor(private root: string) { super(); }
  override sessionRoots() { return [this.root]; }
  override matches(p: string) { return p.endsWith('.jsonl'); }
  override parseFile(filePath: string, content: string) {
    this.parseCount++;
    return super.parseFile(filePath, content);
  }
}

const FIXTURE = path.join(__dirname, '../../../../fixtures/claude/session-toolsearch.jsonl');

afterEach(() => vi.useRealTimers());

describe('LogWatcher.backfill', () => {
  it('parses every session file under the root and ingests it into the store', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    copyFileSync(FIXTURE, path.join(dir, 's1.jsonl'));
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    const r = await w.backfill();
    expect(r.files).toBe(1);
    expect(store.callsSince('2000-01-01').length).toBeGreaterThan(0);
  });

  it('skips the second backfill when the mtime is unchanged', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const f = path.join(dir, 's1.jsonl');
    copyFileSync(FIXTURE, f);
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    await w.backfill();
    const r2 = await w.backfill();
    expect(r2.files).toBe(0); // the cursor mtime matches, so it is skipped
  });

  it('ingests again when the mtime changes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const f = path.join(dir, 's1.jsonl');
    copyFileSync(FIXTURE, f);
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    await w.backfill();

    // Move the mtime into the future to make it look changed
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);

    const r2 = await w.backfill();
    expect(r2.files).toBe(1);
  });

  it('accumulates parseErrors when a line fails to parse', async () => {
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

  it('ingests the rest without throwing even with a missing or broken file (a dangling symlink)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    copyFileSync(FIXTURE, path.join(dir, 's1.jsonl'));
    // A broken symlink pointing at a nonexistent target, causing ENOENT on stat/readFile
    symlinkSync(path.join(dir, 'does-not-exist.jsonl'), path.join(dir, 'broken.jsonl'));
    const store = await LensStore.open(':memory:');
    const w = new LogWatcher(store, [new TestClaudeAdapter(dir)]);
    const r = await w.backfill();
    expect(r.files).toBe(1); // only the healthy file counts; the broken one is skipped silently
    expect(store.callsSince('2000-01-01').length).toBeGreaterThan(0);
  });

  it('does not read a symlink pointing at a valid file outside the root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'lens-outside-'));
    const outsideFile = path.join(outside, 'outside.jsonl');
    copyFileSync(FIXTURE, outsideFile);
    symlinkSync(outsideFile, path.join(root, 'escape.jsonl'));
    const adapter = new TestClaudeAdapter(root);
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [adapter]);

    const result = await watcher.backfill();

    expect(result.files).toBe(0);
    expect(adapter.parseCount).toBe(0);
    expect(store.callsSince('2000-01-01')).toEqual([]);
  });

  it('counts an adapter exception as a parseError without counting the file as processed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lens-'));
    const file = path.join(dir, 's1.jsonl');
    copyFileSync(FIXTURE, file);
    const adapter = new TestClaudeAdapter(dir);
    adapter.parseFile = vi.fn(() => { throw new Error('adapter failed'); });
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [adapter]);

    await expect(watcher.backfill()).resolves.toEqual({ files: 0, parseErrors: 1 });
  });
});

describe('LogWatcher.reconcilePath', () => {
  it('rejects paths outside the allowed roots, symlink escapes and directories', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'lens-outside-'));
    const outsideFile = path.join(outside, 'outside.jsonl');
    writeFileSync(outsideFile, '{}\n');
    const escape = path.join(root, 'escape.jsonl');
    symlinkSync(outsideFile, escape);
    const directory = path.join(root, 'directory.jsonl');
    mkdirSync(directory);
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [new TestClaudeAdapter(root)], {
      allowedRoots: () => [root], debounceMs: 5,
    });

    const receipts = [
      watcher.reconcilePath(outsideFile, 'hook'),
      watcher.reconcilePath(escape, 'hook'),
      watcher.reconcilePath(directory, 'hook'),
    ];
    await vi.advanceTimersByTimeAsync(5);

    await expect(Promise.all(receipts)).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', errorCode: 'outside-root' }),
      expect.objectContaining({ status: 'rejected', errorCode: 'outside-root' }),
      expect.objectContaining({ status: 'rejected', errorCode: 'not-regular-file' }),
    ]);
  });

  it('debounces three requests for the same path into one parse', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 's.jsonl');
    copyFileSync(FIXTURE, file);
    const adapter = new TestClaudeAdapter(root);
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [adapter], {
      allowedRoots: () => [root], debounceMs: 10,
    });

    const requests = [
      watcher.reconcilePath(file, 'hook'),
      watcher.reconcilePath(file, 'chokidar'),
      watcher.reconcilePath(file, 'hook'),
    ];
    await vi.advanceTimersByTimeAsync(10);

    const receipts = await Promise.all(requests);
    expect(adapter.parseCount).toBe(1);
    expect(receipts.every((receipt) => receipt.status === 'ingested')).toBe(true);
    expect(receipts.map((receipt) => receipt.trigger)).toEqual(['hook', 'chokidar', 'hook']);
  });

  it('retries a delayed transcript at 250ms, 1s and 3s', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 'late.jsonl');
    const store = await LensStore.open(':memory:');
    const receipts: unknown[] = [];
    const retryDelays: number[] = [];
    const watcher = new LogWatcher(store, [new TestClaudeAdapter(root)], {
      allowedRoots: () => [root], debounceMs: 5,
      retryDelaysMs: [250, 1_000, 3_000],
      onReceipt: (receipt) => receipts.push(receipt),
      setTimer: (callback, delayMs) => {
        if (delayMs !== 5) retryDelays.push(delayMs);
        return setTimeout(callback, delayMs);
      },
    });

    const reconciliation = watcher.reconcilePath(file, 'hook');
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(reconciliation).resolves.toEqual(expect.objectContaining({
      trigger: 'hook', status: 'rejected', errorCode: 'transcript-missing', parseErrors: 0,
    }));
    expect(retryDelays).toEqual([250, 1_000, 3_000]);
    expect(receipts).toHaveLength(1);
  });

  it('ingests on the next attempt when the transcript appears during the retry wait', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 'late.jsonl');
    const adapter = new TestClaudeAdapter(root);
    const store = await LensStore.open(':memory:');
    const retryDelays: number[] = [];
    const watcher = new LogWatcher(store, [adapter], {
      allowedRoots: () => [root], debounceMs: 5,
      setTimer: (callback, delayMs) => {
        if (delayMs !== 5) retryDelays.push(delayMs);
        return setTimeout(callback, delayMs);
      },
    });

    const reconciliation = watcher.reconcilePath(file, 'hook');
    await vi.advanceTimersByTimeAsync(5);
    setTimeout(() => copyFileSync(FIXTURE, file), 100);
    await vi.advanceTimersByTimeAsync(250);

    await expect(reconciliation).resolves.toEqual(expect.objectContaining({
      status: 'ingested', trigger: 'hook', errorCode: null,
    }));
    expect(retryDelays).toEqual([250]);
    expect(adapter.parseCount).toBe(1);
  });

  it('shares one pending parse between a chokidar event from start and a hook request', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 's.jsonl');
    copyFileSync(FIXTURE, file);
    const adapter = new TestClaudeAdapter(root);
    const store = await LensStore.open(':memory:');
    const handlers = new Map<string, (filePath: string) => void>();
    const fakeWatcher = {
      on(event: string, handler: (filePath: string) => void) {
        handlers.set(event, handler);
        return this;
      },
      close: async () => {},
    };
    const emitted: string[] = [];
    const watcher = new LogWatcher(store, [adapter], {
      allowedRoots: () => [root], debounceMs: 10,
      watchFactory: () => fakeWatcher,
      onReceipt: (receipt) => emitted.push(receipt.trigger),
    });
    watcher.start();

    const hookReceipt = watcher.reconcilePath(file, 'hook');
    handlers.get('change')?.(file);
    await vi.advanceTimersByTimeAsync(10);

    await expect(hookReceipt).resolves.toEqual(expect.objectContaining({ trigger: 'hook' }));
    expect(adapter.parseCount).toBe(1);
    expect(emitted).toEqual(['hook', 'chokidar']);
    await watcher.stop();
  });

  it('records an adapter parse exception as a receipt and handles the next request', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 's.jsonl');
    writeFileSync(file, '{}\n');
    const adapter = new TestClaudeAdapter(root);
    const original = adapter.parseFile.bind(adapter);
    adapter.parseFile = vi.fn()
      .mockImplementationOnce(() => { throw new Error('bad transcript'); })
      .mockImplementation(original);
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [adapter], {
      allowedRoots: () => [root], debounceMs: 5,
    });

    const first = watcher.reconcilePath(file, 'hook');
    await vi.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toEqual(expect.objectContaining({
      trigger: 'hook', status: 'failed', parseErrors: 1,
    }));
    utimesSync(file, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));
    const second = watcher.reconcilePath(file, 'chokidar');
    await vi.advanceTimersByTimeAsync(5);
    await expect(second).resolves.toEqual(expect.objectContaining({ status: 'ingested' }));
  });

  it('does not advance the cursor after one failed save and re-ingests on the next unchanged request', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 's.jsonl');
    copyFileSync(FIXTURE, file);
    const adapter = new TestClaudeAdapter(root);
    const store = await LensStore.open(':memory:');
    const save = vi.spyOn(store, 'save')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation(() => {});
    const watcher = new LogWatcher(store, [adapter], {
      allowedRoots: () => [root], debounceMs: 5,
    });

    const first = watcher.reconcilePath(file, 'hook');
    await vi.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toEqual(expect.objectContaining({ status: 'failed' }));

    const second = watcher.reconcilePath(file, 'hook');
    await vi.advanceTimersByTimeAsync(5);
    await expect(second).resolves.toEqual(expect.objectContaining({ status: 'ingested' }));
    expect(adapter.parseCount).toBe(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not let an ingested listener exception turn a successful persist into parse-failed', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 's.jsonl');
    copyFileSync(FIXTURE, file);
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [new TestClaudeAdapter(root)], {
      allowedRoots: () => [root], debounceMs: 5,
    });
    const laterListener = vi.fn();
    watcher.on('ingested', () => { throw new Error('observer failed'); });
    watcher.on('ingested', laterListener);

    const request = watcher.reconcilePath(file, 'hook');
    await vi.advanceTimersByTimeAsync(5);

    await expect(request).resolves.toEqual(expect.objectContaining({
      status: 'ingested', errorCode: null, parseErrors: 0,
    }));
    expect(store.callsSince('2000-01-01').length).toBeGreaterThan(0);
    expect(laterListener).toHaveBeenCalledWith(realpathSync(file));
  });

  it('resolves every debounced caller promise even when a receipt listener throws', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'lens-root-'));
    const file = path.join(root, 's.jsonl');
    copyFileSync(FIXTURE, file);
    const store = await LensStore.open(':memory:');
    const watcher = new LogWatcher(store, [new TestClaudeAdapter(root)], {
      allowedRoots: () => [root], debounceMs: 5,
    });
    const laterListener = vi.fn();
    watcher.on('receipt', () => { throw new Error('observer failed'); });
    watcher.on('receipt', laterListener);

    const requests = [
      watcher.reconcilePath(file, 'hook'),
      watcher.reconcilePath(file, 'chokidar'),
      watcher.reconcilePath(file, 'hook'),
    ];
    await vi.advanceTimersByTimeAsync(5);

    await expect(Promise.all(requests)).resolves.toEqual([
      expect.objectContaining({ status: 'ingested', trigger: 'hook' }),
      expect.objectContaining({ status: 'ingested', trigger: 'chokidar' }),
      expect.objectContaining({ status: 'ingested', trigger: 'hook' }),
    ]);
    expect(laterListener).toHaveBeenCalledTimes(3);
  });
});
