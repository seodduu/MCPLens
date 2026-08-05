// packages/core/test/scanner/attribution.test.ts
import { describe, it, expect } from 'vitest';
import { clientForSourceKind, attributeServers, type SourceRead }
  from '../../src/scanner/attribution.js';

describe('clientForSourceKind', () => {
  it('folds claude-user and claude-project into claude-code', () => {
    expect(clientForSourceKind('claude-user')).toBe('claude-code');
    expect(clientForSourceKind('claude-project')).toBe('claude-code');
  });

  it('maps codex and gemini to their own clients', () => {
    expect(clientForSourceKind('codex')).toBe('codex');
    expect(clientForSourceKind('gemini')).toBe('gemini-cli');
  });

  it('maps an unknown kind to null', () => {
    expect(clientForSourceKind('unknown-thing')).toBeNull();
  });
});

describe('attributeServers', () => {
  const read = (kind: string, servers: string[],
    failed: SourceRead['failed'] = 'none'): SourceRead => ({ kind, servers, failed });

  it('attributes a server to the client of its config source', () => {
    const { attribution } = attributeServers([
      read('claude-user', ['notion', 'deepwiki']),
      read('codex', ['node_repl']),
    ]);
    expect([...attribution.get('notion')!]).toEqual(['claude-code']);
    expect([...attribution.get('node_repl')!]).toEqual(['codex']);
  });

  it('attributes a server present in two sources to both clients', () => {
    const { attribution } = attributeServers([
      read('claude-user', ['deepwiki']),
      read('codex', ['deepwiki']),
    ]);
    expect([...attribution.get('deepwiki')!].sort()).toEqual(['claude-code', 'codex']);
  });

  it('merges servers from claude-user and claude-project into one client', () => {
    const { attribution } = attributeServers([
      read('claude-user', ['notion']),
      read('claude-project', ['projserver']),
    ]);
    expect([...attribution.get('notion')!]).toEqual(['claude-code']);
    expect([...attribution.get('projserver')!]).toEqual(['claude-code']);
  });

  it('treats a missing file as normal, leaving that client replaceable', () => {
    const { replaceable } = attributeServers([read('gemini', [], 'missing')]);
    expect(replaceable.has('gemini-cli')).toBe(true);
  });

  it('drops a client from replaceable when a read error occurs', () => {
    const { replaceable } = attributeServers([read('gemini', [], 'error')]);
    expect(replaceable.has('gemini-cli')).toBe(false);
  });

  it('drops the whole client from replaceable when even one source errors', () => {
    const { replaceable } = attributeServers([
      read('claude-user', ['notion'], 'none'),
      read('claude-project', [], 'error'),
    ]);
    expect(replaceable.has('claude-code')).toBe(false);
  });

  it('ignores an unknown source kind', () => {
    const { attribution, replaceable } = attributeServers([read('weird', ['x'])]);
    expect(attribution.size).toBe(0);
    expect(replaceable.size).toBe(0);
  });
});
