import { describe, it, expect } from 'vitest';
import { collectAction } from '../src/pauseDecision.js';

describe('collectAction', () => {
  it('중지 상태 + writer면 stop (중지가 리스보다 우선)', () => {
    expect(collectAction(true, 'writer')).toBe('stop');
  });
  it('중지 상태 + read-only면 stop', () => {
    expect(collectAction(true, 'read-only')).toBe('stop');
  });
  it('활성 상태 + writer면 start', () => {
    expect(collectAction(false, 'writer')).toBe('start');
  });
  it('활성 상태 + read-only면 stop (read-only는 DB에 쓸 수 없다)', () => {
    expect(collectAction(false, 'read-only')).toBe('stop');
  });
});
