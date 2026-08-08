import { CALL_CHAIN_MIN_SESSIONS } from './callChains.js';

export interface ReanalysisTriggerInput {
  /** observedSessionCount stored on the cached verdict. */
  storedSessionCount: number;
  /** Distinct sessions for this server right now, same 90-day window. */
  currentSessionCount: number;
}

/**
 * True when a cached verdict was reached before the call-chain tier could say anything and enough
 * sessions have since accumulated for it to speak.
 *
 * Fires at most once per server: after the rerun stores a count at or above the threshold, the
 * left-hand condition is false forever. Without that property a busy server would be re-analyzed
 * on every activation and spend the user's tokens each time.
 *
 * Says nothing about how many servers may act on it in one run. The caller applies that budget,
 * because only the caller knows whether a human is present to see the cost.
 */
export function needsCallChainReanalysis(input: ReanalysisTriggerInput): boolean {
  return input.storedSessionCount < CALL_CHAIN_MIN_SESSIONS
    && input.currentSessionCount >= CALL_CHAIN_MIN_SESSIONS;
}
