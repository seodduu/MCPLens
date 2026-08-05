import { describe, it, expect } from 'vitest';
import { chooseMode } from '../src/leaseMode.js';

describe('chooseMode', () => {
  it('is writer when the lease is acquired', () => { expect(chooseMode(true)).toBe('writer'); });
  it('is read-only when it is not', () => { expect(chooseMode(false)).toBe('read-only'); });
});
