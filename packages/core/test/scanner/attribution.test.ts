// packages/core/test/scanner/attribution.test.ts
import { describe, it, expect } from 'vitest';
import { clientForSourceKind, attributeServers, type SourceRead }
  from '../../src/scanner/attribution.js';

describe('clientForSourceKind', () => {
  it('claude-user와 claude-project는 모두 claude-code로 접힌다', () => {
    expect(clientForSourceKind('claude-user')).toBe('claude-code');
    expect(clientForSourceKind('claude-project')).toBe('claude-code');
  });

  it('codex와 gemini를 각 클라이언트로 매핑한다', () => {
    expect(clientForSourceKind('codex')).toBe('codex');
    expect(clientForSourceKind('gemini')).toBe('gemini-cli');
  });

  it('모르는 종류는 null이다', () => {
    expect(clientForSourceKind('unknown-thing')).toBeNull();
  });
});

describe('attributeServers', () => {
  const read = (kind: string, servers: string[],
    failed: SourceRead['failed'] = 'none'): SourceRead => ({ kind, servers, failed });

  it('서버를 설정 출처의 클라이언트에 귀속시킨다', () => {
    const { attribution } = attributeServers([
      read('claude-user', ['notion', 'deepwiki']),
      read('codex', ['node_repl']),
    ]);
    expect([...attribution.get('notion')!]).toEqual(['claude-code']);
    expect([...attribution.get('node_repl')!]).toEqual(['codex']);
  });

  it('같은 서버가 두 소스에 있으면 두 클라이언트 모두에 귀속된다', () => {
    const { attribution } = attributeServers([
      read('claude-user', ['deepwiki']),
      read('codex', ['deepwiki']),
    ]);
    expect([...attribution.get('deepwiki')!].sort()).toEqual(['claude-code', 'codex']);
  });

  it('claude-user와 claude-project의 서버가 한 클라이언트로 합쳐진다', () => {
    const { attribution } = attributeServers([
      read('claude-user', ['notion']),
      read('claude-project', ['projserver']),
    ]);
    expect([...attribution.get('notion')!]).toEqual(['claude-code']);
    expect([...attribution.get('projserver')!]).toEqual(['claude-code']);
  });

  it('파일 부재는 정상 — 그 클라이언트는 교체 대상이다', () => {
    const { replaceable } = attributeServers([read('gemini', [], 'missing')]);
    expect(replaceable.has('gemini-cli')).toBe(true);
  });

  it('읽기 오류가 나면 그 클라이언트는 교체 대상에서 빠진다', () => {
    const { replaceable } = attributeServers([read('gemini', [], 'error')]);
    expect(replaceable.has('gemini-cli')).toBe(false);
  });

  it('한 소스라도 읽기 오류면 그 클라이언트 전체가 교체 대상에서 빠진다', () => {
    const { replaceable } = attributeServers([
      read('claude-user', ['notion'], 'none'),
      read('claude-project', [], 'error'),
    ]);
    expect(replaceable.has('claude-code')).toBe(false);
  });

  it('모르는 소스 종류는 무시한다', () => {
    const { attribution, replaceable } = attributeServers([read('weird', ['x'])]);
    expect(attribution.size).toBe(0);
    expect(replaceable.size).toBe(0);
  });
});
