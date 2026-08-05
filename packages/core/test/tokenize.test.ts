import { describe, it, expect } from 'vitest';
import { countTokens } from '../src/tokenize.js';

describe('countTokens', () => {
  it('counts an empty string as 0', () => expect(countTokens('')).toBe(0));
  it('counts an English sentence as a positive integer', () => {
    const n = countTokens('list repository issues by label');
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});
