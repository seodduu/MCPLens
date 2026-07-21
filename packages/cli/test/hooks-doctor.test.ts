import { describe, expect, it } from 'vitest';
import {
  diagnoseHooks,
  formatHookDiagnosis,
} from '../src/hooks-doctor.js';
import type { HookStatus } from '../src/hooks-status.js';

const status = (overrides: Partial<HookStatus> = {}): HookStatus => ({
  client: 'codex',
  packageState: 'installed',
  trustState: 'unknown',
  runnerState: 'ready',
  lastEvent: '2026-07-20T12:00:00.000Z',
  pendingCount: 0,
  fallbackState: 'active',
  health: 'healthy',
  ...overrides,
});

describe('diagnoseHooks', () => {
  it('reports unreadable Codex trust as a warning, never as approved', () => {
    const diagnosis = diagnoseHooks([status()]);

    expect(diagnosis).toEqual(expect.arrayContaining([
      expect.objectContaining({
        client: 'codex',
        level: 'warning',
        code: 'codex-trust-unknown',
      }),
    ]));
    expect(formatHookDiagnosis(diagnosis)).not.toContain('approved');
  });

  it('distinguishes missing package and runner failures from collection warnings', () => {
    const diagnosis = diagnoseHooks([
      status({ client: 'claude-code', packageState: 'missing', runnerState: 'missing' }),
      status({ client: 'gemini-cli', pendingCount: 3, health: 'degraded' }),
    ]);

    expect(diagnosis).toEqual(expect.arrayContaining([
      expect.objectContaining({ client: 'claude-code', level: 'failure', code: 'package-missing' }),
      expect.objectContaining({ client: 'gemini-cli', level: 'warning', code: 'pending-events' }),
      expect.objectContaining({ client: 'gemini-cli', level: 'warning', code: 'health-degraded' }),
    ]));
    expect(diagnosis).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ client: 'claude-code', code: 'runner-missing' }),
    ]));
  });
});
