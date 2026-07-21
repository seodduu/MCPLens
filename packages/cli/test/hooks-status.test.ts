import { describe, expect, it } from 'vitest';
import {
  formatHookStatus,
  type HookStatus,
} from '../src/hooks-status.js';

const status = (client: HookStatus['client']): HookStatus => ({
  client,
  packageState: 'installed',
  trustState: client === 'codex' ? 'unknown' : 'not-required',
  runnerState: 'ready',
  lastEvent: '2026-07-20T12:00:00.000Z',
  pendingCount: 2,
  fallbackState: 'active',
  health: 'healthy',
});

describe('formatHookStatus', () => {
  it('emits stable JSON containing every hook collection field', () => {
    const output = formatHookStatus([status('gemini-cli'), status('codex')], true);

    expect(output).toBe(`${JSON.stringify([
      status('codex'),
      status('gemini-cli'),
    ], null, 2)}\n`);
  });

  it('renders the same fields for human-readable status output', () => {
    const output = formatHookStatus([status('claude-code')], false);

    expect(output).toContain('Claude Code');
    expect(output).toContain('package: installed');
    expect(output).toContain('trust: not-required');
    expect(output).toContain('runner: ready');
    expect(output).toContain('last event: 2026-07-20T12:00:00.000Z');
    expect(output).toContain('pending: 2');
    expect(output).toContain('fallback: active');
    expect(output).toContain('health: healthy');
  });
});
