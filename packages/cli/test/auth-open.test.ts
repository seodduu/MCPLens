import { describe, it, expect } from 'vitest';
import { resolveOpenCommand } from '../src/auth-open.js';

describe('resolveOpenCommand', () => {
  it('macOS는 open 커맨드를 사용한다', () => {
    expect(resolveOpenCommand('darwin', 'https://example.com/authorize')).toEqual({
      command: 'open',
      args: ['https://example.com/authorize'],
    });
  });

  it('Linux는 xdg-open 커맨드를 사용한다', () => {
    expect(resolveOpenCommand('linux', 'https://example.com/authorize')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com/authorize'],
    });
  });

  it('Windows는 cmd /c start 커맨드를 사용한다', () => {
    expect(resolveOpenCommand('win32', 'https://example.com/authorize')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'https://example.com/authorize'],
    });
  });

  it('알 수 없는 플랫폼은 xdg-open으로 폴백한다', () => {
    expect(resolveOpenCommand('freebsd' as NodeJS.Platform, 'https://example.com')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com'],
    });
  });
});
