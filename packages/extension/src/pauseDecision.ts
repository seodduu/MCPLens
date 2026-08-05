import type { LeaseMode } from './leaseMode.js';

export type CollectAction = 'start' | 'stop';

/**
 * Decides whether hook pending-watching is on or off.
 * It watches only while this window is the writer and not paused: a read-only holder cannot write to
 * the DB, and a pause outranks a lease promotion (it is the user's explicit intent).
 */
export function collectAction(paused: boolean, mode: LeaseMode): CollectAction {
  if (paused) return 'stop';
  return mode === 'writer' ? 'start' : 'stop';
}
