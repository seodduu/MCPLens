import { describe, it, expect } from 'vitest';
import { claimFirstRun, WALKTHROUGH_OPENED_KEY, type FirstRunState } from '../src/firstRun.js';

function fakeState(seed: Map<string, boolean> = new Map()): FirstRunState {
  return {
    get: (key) => seed.get(key),
    update: async (key, value) => { seed.set(key, value); },
  };
}

describe('claimFirstRun', () => {
  it('첫 호출은 참을 돌려주고 플래그를 기록한다', async () => {
    const seed = new Map<string, boolean>();
    const state = fakeState(seed);
    await expect(claimFirstRun(state)).resolves.toBe(true);
    expect(seed.get(WALKTHROUGH_OPENED_KEY)).toBe(true);
  });

  it('플래그가 이미 있으면 거짓', async () => {
    const seed = new Map<string, boolean>([[WALKTHROUGH_OPENED_KEY, true]]);
    const state = fakeState(seed);
    await expect(claimFirstRun(state)).resolves.toBe(false);
  });

  it('두 번 연속 부르면 두 번째는 거짓', async () => {
    const seed = new Map<string, boolean>();
    const state = fakeState(seed);
    await expect(claimFirstRun(state)).resolves.toBe(true);
    await expect(claimFirstRun(state)).resolves.toBe(false);
  });

  it('update가 끝난 뒤에 참을 돌려준다', async () => {
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
