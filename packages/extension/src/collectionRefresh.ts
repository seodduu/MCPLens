/**
 * Stale-run guard for computeCollection().
 *
 * While computeCollection() waits on a CLI subprocess (detect()) per client, a new refresh can
 * overlap. Previously only lastCollectionInputs and the collection-status row update sat inside the
 * generation guard, while refreshSetupKeys/refreshSetupRows ran unconditionally outside it.
 * A stale run finishing late could then overwrite context keys the newest run had already applied,
 * and fire welcome.markStepIncomplete wrongly, erasing a checkmark the user had just earned
 *
 * A single apply callback bundles "every side effect that reflects this run's result", so a
 * generation mismatch skips all of them and a match applies all of them. That structurally rules out
 *
 * It is not exported: applyCollectionResult is the only entry point, so even if the old bug returns
 * and computeCollection() in extension.ts calls refreshSetupKeys/refreshSetupRows outside the guard,
 * there is no way to call them without going through applyCollectionResult. This function used to be
 * exported, which left a blind spot: a caller could bypass the guard and the tests would still stay
 * green as long as they called this function directly.
 */
async function withGenerationGuard(
  gen: number,
  currentGeneration: () => number,
  apply: () => Promise<void> | void,
): Promise<void> {
  if (gen === currentGeneration()) {
    await apply();
  }
}

/**
 * The three side effects actually run when one computeCollection() cycle finishes and applies its result.
 * extension.ts fills in the callbacks that depend on the vscode API, and this module owns only the order and the guard.
 * (It never imports vscode, so unit tests can verify that order and guard directly.)
 */
export interface CollectionResultEffects<TInputs> {
  applyInputs: (inputs: TInputs) => void;
  refreshSetupKeys: (inputs: TInputs) => Promise<void> | void;
  /** The collection-status rows are drawn by the Setup Status view too, so they ride along in this single refresh. */
  refreshSetupRows: (inputs: TInputs) => void;
}

/**
 * The guard application point of computeCollection(), extracted as a pure function.
 * Exactly as with withGenerationGuard, the three side effects run in order
 * (applyInputs -> refreshSetupKeys -> refreshSetupRows) only when gen equals currentGeneration() at
 * the start; on a mismatch none of them runs. Once started (once gen passes), a generation change
 * midway does not stop it: withGenerationGuard does not re-check during the run.
 */
export async function applyCollectionResult<TInputs>(
  gen: number,
  currentGeneration: () => number,
  inputs: TInputs,
  effects: CollectionResultEffects<TInputs>,
): Promise<void> {
  await withGenerationGuard(gen, currentGeneration, async () => {
    effects.applyInputs(inputs);
    await effects.refreshSetupKeys(inputs);
    effects.refreshSetupRows(inputs);
  });
}
