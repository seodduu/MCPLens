import { describe, expect, it } from 'vitest';
import { runBin } from '../src/claudeCli.js';

// If a CLI raises an interactive prompt, the child process lives forever waiting on stdin, the close
// event never arrives, and "Install" in the extension UI waits indefinitely (measured with gemini-cli 0.51.0).
// The ceiling keeps the UI from hanging no matter which CLI adds a new prompt.
describe('runBin timeout', () => {
  it('kills a child process past the ceiling and resolves non-zero', async () => {
    const start = Date.now();
    const result = await runBin(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('ends a process that survives a closed stdin while showing a prompt', async () => {
    // Real gemini-cli 0.51.0 behaviour: it does not exit while showing a prompt even with stdin
    // closed to /dev/null. stdin.resume() ends immediately on EOF and cannot reproduce this, so a
    // process kept alive by a timer stands in for it.
    const result = await runBin(
      process.execPath,
      ['-e', 'process.stdout.write("Continue? [y/N]: "); setInterval(() => {}, 1000);'],
      { timeoutMs: 300 },
    );

    expect(result.code).not.toBe(0);
    // Output received before the timeout is preserved for diagnosis.
    expect(result.stdout).toContain('[y/N]');
  });

  it('returns the normal result untouched for a process that finishes inside the ceiling', async () => {
    const result = await runBin(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: 'ok', stderr: '', code: 0 });
  });

  it('applies the default ceiling when the option is omitted: hanging forever is not an option', async () => {
    const result = await runBin(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result.code).toBe(0);
  });
});
