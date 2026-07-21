import { describe, expect, it } from 'vitest';
import { findClaudeBinary, runClaude } from '../src/claudeCli.js';

describe('findClaudeBinary', () => {
  it('returns null or a string without throwing', () => {
    const result = findClaudeBinary();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('runClaude', () => {
  it('resolves with captured stdout and exit code from an async spawn', async () => {
    const result = await runClaude(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result).toEqual({ stdout: 'ok', stderr: '', code: 0 });
  });

  it('resolves (never rejects) with a non-zero code when the binary is missing', async () => {
    const result = await runClaude('/no/such/claude-binary', ['plugin', 'list']);
    expect(result.code).not.toBe(0);
  });
});
