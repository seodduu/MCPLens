import { describe, it, expect, vi } from 'vitest';
import { applyCollectionResult } from '../src/collectionRefresh.js';

// The point computeCollection() actually calls: extension.ts passes only the vscode-wrapping
// callbacks (applyInputs/refreshSetupKeys/refreshSetupRows) into this function. The module never
// imports vscode, so calling it directly here gives a test that fails if the bug where
// refreshSetupKeys/refreshSetupRows run outside the guard ever returns.
describe('applyCollectionResult', () => {
  it('runs no effect at all when the generation has moved on', async () => {
    const applyInputs = vi.fn();
    const refreshSetupKeys = vi.fn();
    const refreshSetupRows = vi.fn();

    // By the time gen(1) starts, a newer run has already bumped collectionGeneration to 2.
    await applyCollectionResult(1, () => 2, ['inputs'], {
      applyInputs,
      refreshSetupKeys,
      refreshSetupRows,
    });

    expect(applyInputs).not.toHaveBeenCalled();
    expect(refreshSetupKeys).not.toHaveBeenCalled();
    expect(refreshSetupRows).not.toHaveBeenCalled();
  });

  it('runs every effect in order when the generation matches', async () => {
    const order: string[] = [];
    const inputs = ['inputs'];

    await applyCollectionResult(1, () => 1, inputs, {
      applyInputs: (i) => { order.push('applyInputs'); expect(i).toBe(inputs); },
      refreshSetupKeys: (i) => { order.push('refreshSetupKeys'); expect(i).toBe(inputs); },
      refreshSetupRows: (i) => { order.push('refreshSetupRows'); expect(i).toBe(inputs); },
    });

    expect(order).toEqual(['applyInputs', 'refreshSetupKeys', 'refreshSetupRows']);
  });

  it('waits for an asynchronous key refresh to finish before refreshing rows', async () => {
    const order: string[] = [];

    await applyCollectionResult(1, () => 1, ['inputs'], {
      applyInputs: () => {},
      refreshSetupKeys: async () => {
        await Promise.resolve();
        order.push('refreshSetupKeys(resolved)');
      },
      refreshSetupRows: () => { order.push('refreshSetupRows'); },
    });

    expect(order).toEqual(['refreshSetupKeys(resolved)', 'refreshSetupRows']);
  });

  it('lets an already-started run finish even when the generation changes mid-run', async () => {
    // withGenerationGuard checks gen only at the start and never re-checks inside apply().
    // So once a run has started, a change to currentGeneration() (a new refresh bumping
    // collectionGeneration while refreshSetupKeys awaits, say) still lets the remaining effects run.
    // This is not a requirement; it pins the current behaviour of the code.
    let generation = 1;
    const order: string[] = [];

    await applyCollectionResult(1, () => generation, ['inputs'], {
      applyInputs: () => { order.push('applyInputs'); },
      refreshSetupKeys: async () => {
        generation = 2; // assume a newer refresh started mid-run
        order.push('refreshSetupKeys');
      },
      refreshSetupRows: () => { order.push('refreshSetupRows'); },
    });

    expect(order).toEqual(['applyInputs', 'refreshSetupKeys', 'refreshSetupRows']);
  });
});
