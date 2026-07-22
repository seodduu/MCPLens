import { describe, it, expect } from 'vitest';
import { chooseMode } from '../src/leaseMode.js';

describe('chooseMode', () => {
  it('리스 획득 시 writer', () => { expect(chooseMode(true)).toBe('writer'); });
  it('미획득 시 read-only', () => { expect(chooseMode(false)).toBe('read-only'); });
});
