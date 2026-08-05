import { describe, expect, it } from 'vitest';
import { readCodexHookStates, withCodexHooksEnabled } from '../src/installers/codexHookState.js';

describe('withCodexHooksEnabled / readCodexHookStates', () => {
  it('appends an enabled = true table at the end of the file when the section is missing', () => {
    const out = withCodexHooksEnabled('[features]\nplugin_hooks = true\n');
    expect(out).toContain('[hooks.state."mcp-lens@mcplens:hooks/hooks.json:pre_tool_use:0:0"]');
    expect(readCodexHookStates(out).every((s) => s.enabled)).toBe(true);
    expect(out).toContain('[features]');            // existing content preserved
  });

  it('adds enabled = true to a section that has only trusted_hash and preserves the hash', () => {
    const before = [
      '[hooks.state."mcp-lens@mcplens:hooks/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).toContain('trusted_hash = "sha256:abc"');
    const state = readCodexHookStates(out).find((s) => s.key.includes('pre_tool_use'))!;
    expect(state).toMatchObject({ enabled: true, trusted: true });
  });

  it('turns enabled = false into true', () => {
    const before = [
      '[hooks.state."mcp-lens@mcplens:hooks/hooks.json:stop:0:0"]',
      'enabled = false',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).not.toContain('enabled = false');
    expect(readCodexHookStates(out).find((s) => s.key.includes('stop'))!.enabled).toBe(true);
  });

  it('leaves the text untouched when it is already enabled (idempotent)', () => {
    const once = withCodexHooksEnabled('');
    expect(withCodexHooksEnabled(once)).toBe(once);
  });

  it('does not touch other plugin sections or the tables after them', () => {
    const before = [
      '[hooks.state."other@x:hooks/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:other"',
      '',
      '[features]',
      'plugin_hooks = true',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).toContain('[hooks.state."other@x:hooks/hooks.json:pre_tool_use:0:0"]');
    expect(out).toContain('trusted_hash = "sha256:other"');
    expect(out).toContain('plugin_hooks = true');
  });

  it('reports trusted as false when trusted_hash is absent', () => {
    expect(readCodexHookStates(withCodexHooksEnabled('')).every((s) => s.trusted)).toBe(false);
  });
});
