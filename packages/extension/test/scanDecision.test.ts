import { describe, it, expect } from 'vitest';
import { decideScanAction } from '../src/scanDecision.js';
import type { McpServerSpec } from '@mcp-lens/core';

const spec = (name: string): McpServerSpec => ({ name, command: 'node', args: [] });

describe('decideScanAction', () => {
  it('stdio 서버가 없으면 무조건 skip', () => {
    expect(decideScanAction({ setting: 'prompt', specs: [], knownServers: new Set() }))
      .toEqual({ kind: 'skip' });
  });
  it('never면 skip', () => {
    expect(decideScanAction({ setting: 'never', specs: [spec('a')], knownServers: new Set() }))
      .toEqual({ kind: 'skip' });
  });
  it('always면 미스캔 서버만 담아 scan', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('a'), spec('b')], knownServers: new Set(['a']) });
    expect(d).toEqual({ kind: 'scan', targets: [spec('b')] });
  });
  it('always여도 전부 스캔돼 있으면 skip', () => {
    expect(decideScanAction({ setting: 'always', specs: [spec('a')], knownServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });
  it('prompt + 미스캔 서버 있음 → prompt (대상 포함)', () => {
    const d = decideScanAction({ setting: 'prompt', specs: [spec('a')], knownServers: new Set() });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('a')] });
  });
  it('prompt여도 전부 스캔돼 있으면 skip (알림 스팸 방지)', () => {
    expect(decideScanAction({ setting: 'prompt', specs: [spec('a')], knownServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });
});
