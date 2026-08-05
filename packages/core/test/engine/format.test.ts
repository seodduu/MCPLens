// packages/core/test/engine/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatTokens } from '../../src/engine/format.js';

describe('formatTokens', () => {
  it('3자리마다 쉼표를 넣는다', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1,000');
    expect(formatTokens(9600)).toBe('9,600');
    expect(formatTokens(1146096)).toBe('1,146,096');
    expect(formatTokens(1000000000)).toBe('1,000,000,000');
  });

  it('음수도 부호를 지키고 소수는 반올림한다', () => {
    expect(formatTokens(-12345)).toBe('-12,345');
    expect(formatTokens(1234.6)).toBe('1,235');
  });

  it('로케일에 흔들리지 않는다 (환경과 무관하게 쉼표)', () => {
    // toLocaleString은 실행 환경에 따라 구분자가 달라질 수 있어 쓰지 않는다.
    expect(formatTokens(1234567)).toBe('1,234,567');
  });

  it('유한하지 않은 값은 그대로 문자열화한다', () => {
    expect(formatTokens(Number.NaN)).toBe('NaN');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});
