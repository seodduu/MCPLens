import { describe, expect, it } from 'vitest';
import { readCodexHookStates, withCodexHooksEnabled } from '../src/installers/codexHookState.js';

describe('withCodexHooksEnabled / readCodexHookStates', () => {
  it('섹션이 없으면 파일 끝에 enabled = true 테이블을 붙인다', () => {
    const out = withCodexHooksEnabled('[features]\nplugin_hooks = true\n');
    expect(out).toContain('[hooks.state."mcp-lens@mcplens:hooks/hooks.json:pre_tool_use:0:0"]');
    expect(readCodexHookStates(out).every((s) => s.enabled)).toBe(true);
    expect(out).toContain('[features]');            // 기존 내용 보존
  });

  it('trusted_hash만 있는 섹션에 enabled = true를 넣고 해시는 보존한다', () => {
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

  it('enabled = false를 true로 바꾼다', () => {
    const before = [
      '[hooks.state."mcp-lens@mcplens:hooks/hooks.json:stop:0:0"]',
      'enabled = false',
      '',
    ].join('\n');
    const out = withCodexHooksEnabled(before);
    expect(out).not.toContain('enabled = false');
    expect(readCodexHookStates(out).find((s) => s.key.includes('stop'))!.enabled).toBe(true);
  });

  it('이미 켜져 있으면 원문을 그대로 둔다 (멱등)', () => {
    const once = withCodexHooksEnabled('');
    expect(withCodexHooksEnabled(once)).toBe(once);
  });

  it('다른 플러그인 섹션과 그 뒤 테이블을 건드리지 않는다', () => {
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

  it('trusted_hash가 없으면 trusted는 거짓이다', () => {
    expect(readCodexHookStates(withCodexHooksEnabled('')).every((s) => s.trusted)).toBe(false);
  });
});
