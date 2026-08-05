import { describe, it, expect } from 'vitest';
import { HELP_TEXT, isHelpRequest } from '../src/help.js';

describe('isHelpRequest', () => {
  it('인자가 없으면 도움말', () => {
    expect(isHelpRequest([])).toBe(true);
  });
  it.each([['--help'], ['-h'], ['help']])('%s 는 도움말', (flag) => {
    expect(isHelpRequest([flag])).toBe(true);
  });
  it('커맨드 뒤의 --help 도 도움말', () => {
    expect(isHelpRequest(['report', '--help'])).toBe(true);
  });
  it('일반 커맨드는 도움말이 아니다', () => {
    expect(isHelpRequest(['report', '--days', '7'])).toBe(false);
    expect(isHelpRequest(['scan'])).toBe(false);
  });
  it('hook 경로는 절대 가로채지 않는다 (fail-open 훅 계약)', () => {
    expect(isHelpRequest(['hook'])).toBe(false);
    expect(isHelpRequest(['hook', 'capture', '--help'])).toBe(false);
    expect(isHelpRequest(['hook', '-h'])).toBe(false);
  });
});

describe('HELP_TEXT', () => {
  it.each(['report', 'scan', 'auth', 'hooks status', 'hooks doctor', 'hook capture'])(
    '실제 존재하는 커맨드 %s 를 안내한다',
    (cmd) => { expect(HELP_TEXT).toContain(cmd); },
  );
  it('report의 주요 옵션을 안내한다', () => {
    expect(HELP_TEXT).toContain('--days');
    expect(HELP_TEXT).toContain('--format');
  });
});
