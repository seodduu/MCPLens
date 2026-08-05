import { describe, it, expect } from 'vitest';
import { claimFirstRun, WALKTHROUGH_OPENED_KEY, type FirstRunState } from '../src/firstRun.js';

function fakeState(seed: Map<string, boolean> = new Map()): FirstRunState {
  return {
    get: (key) => seed.get(key),
    update: async (key, value) => { seed.set(key, value); },
  };
}

describe('claimFirstRun', () => {
  it('returns true on the first call and records the flag', async () => {
    const seed = new Map<string, boolean>();
    const state = fakeState(seed);
    await expect(claimFirstRun(state)).resolves.toBe(true);
    expect(seed.get(WALKTHROUGH_OPENED_KEY)).toBe(true);
  });

  it('returns false when the flag already exists', async () => {
    const seed = new Map<string, boolean>([[WALKTHROUGH_OPENED_KEY, true]]);
    const state = fakeState(seed);
    await expect(claimFirstRun(state)).resolves.toBe(false);
  });

  it('returns false on the second of two consecutive calls', async () => {
    const seed = new Map<string, boolean>();
    const state = fakeState(seed);
    await expect(claimFirstRun(state)).resolves.toBe(true);
    await expect(claimFirstRun(state)).resolves.toBe(false);
  });

  it('returns true only after the update finishes', async () => {
    const seed = new Map<string, boolean>();
    let sideEffect = false;
    const state: FirstRunState = {
      get: (key) => seed.get(key),
      update: (key, value) => new Promise((resolve) => {
        setTimeout(() => {
          seed.set(key, value);
          sideEffect = true;
          resolve();
        }, 0);
      }),
    };
    const result = await claimFirstRun(state);
    expect(result).toBe(true);
    expect(sideEffect).toBe(true);
  });
});
