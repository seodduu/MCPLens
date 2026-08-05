import { describe, it, expect } from 'vitest';
import { HELP_TEXT, isHelpRequest } from '../src/help.js';

describe('isHelpRequest', () => {
  it('treats no arguments as a help request', () => {
    expect(isHelpRequest([])).toBe(true);
  });
  it.each([['--help'], ['-h'], ['help']])('treats %s as a help request', (flag) => {
    expect(isHelpRequest([flag])).toBe(true);
  });
  it('treats a trailing --help as a help request', () => {
    expect(isHelpRequest(['report', '--help'])).toBe(true);
  });
  it('does not treat a normal command as a help request', () => {
    expect(isHelpRequest(['report', '--days', '7'])).toBe(false);
    expect(isHelpRequest(['scan'])).toBe(false);
  });
  it('never intercepts the hook path (fail-open hook contract)', () => {
    expect(isHelpRequest(['hook'])).toBe(false);
    expect(isHelpRequest(['hook', 'capture', '--help'])).toBe(false);
    expect(isHelpRequest(['hook', '-h'])).toBe(false);
  });
});

describe('HELP_TEXT', () => {
  it.each(['report', 'scan', 'auth', 'hooks status', 'hooks doctor', 'hook capture'])(
    'documents the real command %s',
    (cmd) => { expect(HELP_TEXT).toContain(cmd); },
  );
  it('documents the main report options', () => {
    expect(HELP_TEXT).toContain('--days');
    expect(HELP_TEXT).toContain('--format');
  });
});
