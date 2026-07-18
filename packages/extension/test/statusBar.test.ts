import { describe, it, expect } from 'vitest';
import { formatStatus } from '../src/statusBar.js';

describe('formatStatus', () => {
  it('shows raw numbers below 1000 saved tokens', () => {
    expect(formatStatus(12, 680)).toBe('Lens: 12 calls · 680 saved');
  });

  it('formats 1000+ saved tokens as x.xk', () => {
    expect(formatStatus(12, 6800)).toBe('Lens: 12 calls · 6.8k saved');
  });

  it('formats exactly 1000 as 1.0k', () => {
    expect(formatStatus(1, 1000)).toBe('Lens: 1 calls · 1.0k saved');
  });

  it('handles zero calls and zero saved', () => {
    expect(formatStatus(0, 0)).toBe('Lens: 0 calls · 0 saved');
  });

  it('rounds down within the k range (floors to one decimal)', () => {
    expect(formatStatus(3, 12345)).toBe('Lens: 3 calls · 12.3k saved');
  });
});
