import { describe, it, expect } from 'vitest';
import { resolveOpenCommand } from '../src/auth-open.js';

describe('resolveOpenCommand', () => {
  it('uses the open command on macOS', () => {
    expect(resolveOpenCommand('darwin', 'https://example.com/authorize')).toEqual({
      command: 'open',
      args: ['https://example.com/authorize'],
    });
  });

  it('uses the xdg-open command on Linux', () => {
    expect(resolveOpenCommand('linux', 'https://example.com/authorize')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com/authorize'],
    });
  });

  it('uses the cmd /c start command on Windows', () => {
    expect(resolveOpenCommand('win32', 'https://example.com/authorize')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'https://example.com/authorize'],
    });
  });

  it('falls back to xdg-open on unknown platforms', () => {
    expect(resolveOpenCommand('freebsd' as NodeJS.Platform, 'https://example.com')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com'],
    });
  });
});
