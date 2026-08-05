import { describe, it, expect } from 'vitest';
import { decideScanAction } from '../src/scanDecision.js';
import type { McpServerSpec } from '@mcp-lens/core';

const spec = (name: string): McpServerSpec => ({ name, command: 'node', args: [] });

describe('decideScanAction', () => {
  it('always skips when there is no stdio server', () => {
    expect(decideScanAction({ setting: 'prompt', specs: [], scannedServers: new Set() }))
      .toEqual({ kind: 'skip' });
  });
  it('skips on never', () => {
    expect(decideScanAction({ setting: 'never', specs: [spec('a')], scannedServers: new Set() }))
      .toEqual({ kind: 'skip' });
  });
  it('scans only the unscanned servers on always', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('a'), spec('b')], scannedServers: new Set(['a']) });
    expect(d).toEqual({ kind: 'scan', targets: [spec('b')] });
  });
  it('skips on always when everything is already scanned', () => {
    expect(decideScanAction({ setting: 'always', specs: [spec('a')], scannedServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });
  it('prompts (with targets) on prompt when unscanned servers exist', () => {
    const d = decideScanAction({ setting: 'prompt', specs: [spec('a')], scannedServers: new Set() });
    expect(d).toEqual({ kind: 'prompt', targets: [spec('a')] });
  });
  it('skips on prompt when everything is already scanned (no notification spam)', () => {
    expect(decideScanAction({ setting: 'prompt', specs: [spec('a')], scannedServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });
  it('excludes unsupported servers from the scan targets', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('a'), spec('figma')], scannedServers: new Set(),
      unsupported: new Set(['figma']) });
    expect(d).toEqual({ kind: 'scan', targets: [spec('a')] });
  });
  it('skips when every unscanned server is unsupported', () => {
    const d = decideScanAction({
      setting: 'always', specs: [spec('figma')], scannedServers: new Set(),
      unsupported: new Set(['figma']) });
    expect(d).toEqual({ kind: 'skip' });
  });
  it('treats a server with definitions but no bodies as unscanned and includes it', () => {
    // Reproduces a legacy DB: the caller passes a body-based set, so it is empty here
    const d = decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set() });
    expect(d).toEqual({ kind: 'scan', targets: [spec('a')] });
  });
  it('does not rescan a server whose bodies are ingested', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set(['a']) }))
      .toEqual({ kind: 'skip' });
  });

  // The first run belongs to the onboarding walkthrough. Scanning first would also make the LLM
  // provider choice for the analysis. Automatic scanning applies only after the user has scanned once.
  it('does not scan on the first run (0 definitions) even on always', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set(), neverScanned: true }))
      .toEqual({ kind: 'skip' });
  });

  it('scans new servers automatically once anything has been scanned', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a'), spec('b')],
      scannedServers: new Set(['a']), neverScanned: false }))
      .toEqual({ kind: 'scan', targets: [spec('b')] });
  });

  // A legacy DB (definitions but no bodies) is not a first run. Judging the first run by bodies
  // would block that user's rescan too.
  it('does not treat a DB with definitions but no bodies as a first run', () => {
    expect(decideScanAction({
      setting: 'always', specs: [spec('a')], scannedServers: new Set(), neverScanned: false }))
      .toEqual({ kind: 'scan', targets: [spec('a')] });
  });
});
