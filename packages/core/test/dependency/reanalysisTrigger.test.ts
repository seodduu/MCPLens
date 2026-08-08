import { describe, it, expect } from 'vitest';
import { needsCallChainReanalysis } from '../../src/dependency/reanalysisTrigger.js';

describe('needsCallChainReanalysis', () => {
  it('fires when a data-less verdict now has enough sessions', () => {
    expect(needsCallChainReanalysis({ storedSessionCount: 0, currentSessionCount: 3 })).toBe(true);
  });

  it('does not fire while sessions are still below the threshold', () => {
    expect(needsCallChainReanalysis({ storedSessionCount: 0, currentSessionCount: 2 })).toBe(false);
  });

  it('does not fire when the verdict already had enough sessions', () => {
    expect(needsCallChainReanalysis({ storedSessionCount: 3, currentSessionCount: 40 })).toBe(false);
  });

  it('does not fire twice for the same server', () => {
    expect(needsCallChainReanalysis({ storedSessionCount: 5, currentSessionCount: 5 })).toBe(false);
  });

  it('fires at the exact threshold and not one below', () => {
    expect(needsCallChainReanalysis({ storedSessionCount: 2, currentSessionCount: 3 })).toBe(true);
    expect(needsCallChainReanalysis({ storedSessionCount: 2, currentSessionCount: 2 })).toBe(false);
  });
});
