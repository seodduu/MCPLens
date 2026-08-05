import { describe, it, expect } from 'vitest';
import { collectAction } from '../src/pauseDecision.js';

describe('collectAction', () => {
  it('stops when paused and writer (a pause outranks the lease)', () => {
    expect(collectAction(true, 'writer')).toBe('stop');
  });
  it('stops when paused and read-only', () => {
    expect(collectAction(true, 'read-only')).toBe('stop');
  });
  it('starts when active and writer', () => {
    expect(collectAction(false, 'writer')).toBe('start');
  });
  it('stops when active and read-only (read-only cannot write to the DB)', () => {
    expect(collectAction(false, 'read-only')).toBe('stop');
  });
});
