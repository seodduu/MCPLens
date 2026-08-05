import { describe, it, expect } from 'vitest';
import { decideScanAction } from '../src/scanDecision.js';
import type { McpServerSpec } from '@mcp-lens/core';

const spec = (name: string): McpServerSpec => ({ name, command: 'node', args: [] });

describe('decideScanAction', () => {
  it('stdio 서버가 없으면 무조건 skip', () => {
    expect(decideScanAction({ setting: 'prompt', specs: [], scannedServers: new Set() }))
      .toEqual({ kind: 'skip' });
  });
  it('never면 skip', () => {
    expect(decideScanAction({ setting: 'never', specs: [spec('a')], scannedServers: new Set() }))
      .toEqual({ kind: 'skip' });
  });
  it('always면 미스캔 서버만 담아 scan', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('a'), spec('b')], scannedServers: new Set(['a']) });
    expect(d).toEqual({ kind: 'scan', targets: [spec('b')] });
  });
  it('always여도 전부 스캔돼 있으면 skip', () => {
    expect(decideScanAction({ setting: 'always', specs: [spec('a')], scannedServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });
  it('prompt + 미스캔 서버 있음 → prompt (대상 포함)', () => {
    const d = decideScanAction({ setting: 'prompt', specs: [spec('a')], scannedServers: new Set() });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('a')] });
  });
  it('prompt여도 전부 스캔돼 있으면 skip (알림 스팸 방지)', () => {
    expect(decideScanAction({ setting: 'prompt', specs: [spec('a')], scannedServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });
  it('지원하지 않는(unsupported) 서버는 스캔 대상에서 제외한다', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('a'), spec('figma')], scannedServers: new Set(),
      unsupported: new Set(['figma']) });
    expect(d).toEqual({ kind: 'scan', targets: [spec('a')] });
  });
  it('미스캔 서버가 전부 unsupported면 skip', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('figma')], scannedServers: new Set(),
      unsupported: new Set(['figma']) });
    expect(d).toEqual({ kind: 'skip' });
  });
  it('definition만 있고 body가 없는 서버는 미스캔으로 보고 대상에 넣는다', () => {
    // 레거시 DB 재현: 호출부가 body 기준 집합을 넘기므로 여기서는 비어 있다
    const d = decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set() });
    expect(d).toEqual({ kind: 'scan', targets: [spec('a')] });
  });
  it('body가 적재된 서버는 재스캔하지 않는다', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });

  // 첫 실행은 온보딩 워크스루의 몫이다. 확장이 먼저 스캔하면 분석에 쓸 LLM 제공자
  // 선택까지 대신 해버린다. 자동 스캔은 사용자가 한 번 스캔한 뒤부터 적용한다.
  it('첫 실행(정의 0건)에는 always여도 스캔하지 않는다', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set(), neverScanned: true }))
      .toEqual({ kind: 'skip' });
  });

  it('한 번이라도 스캔한 뒤에는 새 서버를 자동으로 스캔한다', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a'), spec('b')],
      scannedServers: new Set(['a']), neverScanned: false }))
      .toEqual({ kind: 'scan', targets: [spec('b')] });
  });

  // 레거시 DB(정의는 있고 body만 없음)는 첫 실행이 아니다. body로 첫 실행을 판정하면
  // 이 사용자의 재스캔까지 막힌다.
  it('정의는 있고 body만 없는 DB는 첫 실행으로 보지 않는다', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set(), neverScanned: false }))
      .toEqual({ kind: 'scan', targets: [spec('a')] });
  });
});
