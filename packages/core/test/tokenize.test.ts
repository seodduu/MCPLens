import { describe, it, expect } from 'vitest';
import { countTokens } from '../src/tokenize.js';

describe('countTokens', () => {
  it('빈 문자열은 0', () => expect(countTokens('')).toBe(0));
  it('영문 문장은 양의 정수', () => {
    const n = countTokens('list repository issues by label');
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});
