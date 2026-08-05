// packages/core/test/engine/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatTokens } from '../../src/engine/format.js';

describe('formatTokens', () => {
  it('inserts a comma every three digits', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(9600)).toBe('9,600');
    expect(formatTokens(1146096)).toBe('1,146,096');
    expect(formatTokens(1000000000)).toBe('1,000,000,000');
  });

  it('keeps the sign on negatives and rounds decimals', () => {
    expect(formatTokens(-12345)).toBe('-12,345');
    expect(formatTokens(1234.6)).toBe('1,235');
  });

  it('is unaffected by the locale (always a comma, in any environment)', () => {
    // toLocaleString is avoided because its separator can change with the runtime environment.
    expect(formatTokens(1234567)).toBe('1,234,567');
  });

  it('stringifies a non-finite value as it is', () => {
    expect(formatTokens(Number.NaN)).toBe('NaN');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});
